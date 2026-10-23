// SPDX-License-Identifier: MIT
// Package sope embeds libsope. Every C-owned string is copied before releasing
// the handle lock; callers never own native pointers or need to write cgo.
package sope

/*
#cgo !sope_static pkg-config: sope
#cgo sope_static pkg-config: sope-static
#include <sope.h>
#include <stdlib.h>
#if SOPE_VERSION_MAJOR != 0 || SOPE_VERSION_MINOR != 5
#error "Go SDK requires sope ABI 0.5"
#endif
*/
import "C"

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

type Code int

const (
	OK        Code = 0
	Failure   Code = -1
	Invalid   Code = -2
	NoMemory  Code = -3
	NotFound  Code = -4
	Closed    Code = -5
	Cancelled Code = -6
	Busy      Code = -7
	Conflict  Code = -8
	Timeout   Code = -9
)

type Error struct {
	Code    Code
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("sope (%d): %s", e.Code, e.Message) }
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t != nil && e != nil && e.Code == t.Code
}

var (
	ErrClosed   = &Error{Closed, "agent closed"}
	ErrBusy     = &Error{Busy, "operation busy"}
	ErrConflict = &Error{Conflict, "configuration or request conflict"}
	ErrNotFound = &Error{NotFound, "not found"}
)

// called on a locked OS thread immediately after the failing native operation.
func result(rc C.int) error {
	if rc >= 0 {
		return nil
	}
	return &Error{Code(rc), C.GoString(C.sope_strerror(rc)) + ": " + C.GoString(C.sope_last_error())}
}
func cstring(s string) (*C.char, func()) {
	p := C.CString(s)
	return p, func() { C.free(unsafe.Pointer(p)) }
}
func validStrings(values ...string) bool {
	for _, s := range values {
		if strings.ContainsRune(s, 0) {
			return false
		}
	}
	return true
}

// Policy is an allowlist, not an OS sandbox. External routes listed built-ins
// to the host executor. Environment is complete and never inherits os.Environ.
type Policy struct {
	Tools       []string          `json:"tools"`
	External    []string          `json:"external,omitempty"`
	Authorize   bool              `json:"authorize"`
	Environment map[string]string `json:"environment"`
}
type Tool struct {
	Name        string
	Description string
	Schema      json.RawMessage
}
type Config struct {
	Directory           string
	Revision            string // host executor and instruction revision
	EnvironmentRevision string // host revision of environment values; values are not journaled
	Options             map[string]string
	Policy              Policy
	Tools               []Tool
	Subagents           []json.RawMessage
}

// Agent must not be copied. Close is required. No finalizer performs cancellation
// or frees memory behind concurrent operations.
type Agent struct {
	gate      chan struct{}
	ptr       *C.sope_agent_t
	polling   atomic.Bool
	closeOnce sync.Once
	closing   atomic.Bool
	stopping  chan struct{}
	closed    chan struct{}
}

func Open(cfg Config) (*Agent, error) {
	if cfg.Directory == "" || cfg.Revision == "" || cfg.EnvironmentRevision == "" || !validStrings(cfg.Directory, cfg.Revision, cfg.EnvironmentRevision) {
		return nil, &Error{Invalid, "directory and explicit contract revisions required"}
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if uint32(C.sope_version_number())>>8 != 0x0005 {
		return nil, &Error{Conflict, "header/library ABI mismatch"}
	}
	a := &Agent{gate: make(chan struct{}, 1), stopping: make(chan struct{}), closed: make(chan struct{})}
	dir, release := cstring(cfg.Directory)
	defer release()
	if err := result(C.sope_agent_open(&a.ptr, dir)); err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			C.sope_agent_free(a.ptr)
		}
	}()
	keys := make([]string, 0, len(cfg.Options))
	for k := range cfg.Options {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v := cfg.Options[k]
		if !validStrings(k, v) {
			return nil, &Error{Invalid, "NUL in option"}
		}
		ck, fk := cstring(k)
		cv, fv := cstring(v)
		err := result(C.sope_agent_set_option(a.ptr, ck, cv))
		fk()
		fv()
		if err != nil {
			return nil, err
		}
	}
	if cfg.Policy.Tools == nil {
		cfg.Policy.Tools = []string{}
	}
	if cfg.Policy.Environment == nil {
		cfg.Policy.Environment = map[string]string{}
	}
	policy, err := json.Marshal(cfg.Policy)
	if err != nil {
		return nil, err
	}
	cp, fp := cstring(string(policy))
	err = result(C.sope_agent_policy(a.ptr, cp, C.size_t(len(policy))))
	fp()
	if err != nil {
		return nil, err
	}
	for _, t := range cfg.Tools {
		if !validStrings(t.Name, t.Description) || !json.Valid(t.Schema) {
			return nil, &Error{Invalid, "invalid tool definition"}
		}
		n, fn := cstring(t.Name)
		d, fd := cstring(t.Description)
		s, fs := cstring(string(t.Schema))
		err = result(C.sope_tool_register(a.ptr, n, d, s))
		fn()
		fd()
		fs()
		if err != nil {
			return nil, err
		}
	}
	for _, def := range cfg.Subagents {
		p, f := cstring(string(def))
		err = result(C.sope_subagent_register(a.ptr, p, C.size_t(len(def))))
		f()
		if err != nil {
			return nil, err
		}
	}
	rev, fr := cstring(cfg.Revision)
	env, fe := cstring(cfg.EnvironmentRevision)
	err = result(C.sope_agent_seal(a.ptr, rev, env))
	fr()
	fe()
	if err != nil {
		return nil, err
	}
	success = true
	return a, nil
}

// withContext serializes pointer and scratch-buffer ownership. Waiting for a
// concurrent native operation is interruptible; an entered C call is never freed
// or abandoned while it still owns the handle.
func (a *Agent) withContext(ctx context.Context, fn func(*C.sope_agent_t) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if a == nil || a.gate == nil || a.closing.Load() {
		return ErrClosed
	}
	select {
	case a.gate <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	case <-a.stopping:
		return ErrClosed
	}
	defer func() { <-a.gate }()
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.ptr == nil || a.closing.Load() {
		return ErrClosed
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	return fn(a.ptr)
}
func (a *Agent) with(fn func(*C.sope_agent_t) error) error {
	return a.withContext(context.Background(), fn)
}
func (a *Agent) SetCredential(token string) error {
	if !validStrings(token) || strings.ContainsAny(token, "\r\n") {
		return &Error{Invalid, "invalid credential"}
	}
	return a.with(func(p *C.sope_agent_t) error {
		k, fk := cstring("openai.api_key")
		v, fv := cstring(token)
		defer fk()
		defer fv()
		return result(C.sope_agent_set_option(p, k, v))
	})
}
func (a *Agent) Submit(key, text string) (uint64, error) {
	var id C.uint64_t
	if key == "" || !validStrings(key) {
		return 0, &Error{Invalid, "request key required"}
	}
	err := a.with(func(p *C.sope_agent_t) error {
		k, fk := cstring(key)
		t, ft := cstring(text)
		defer fk()
		defer ft()
		return result(C.sope_submit(p, k, t, C.size_t(len(text)), &id))
	})
	return uint64(id), err
}
func (a *Agent) Cancel() error {
	return a.with(func(p *C.sope_agent_t) error { return result(C.sope_cancel(p)) })
}
func (a *Agent) Resume() error {
	return a.with(func(p *C.sope_agent_t) error { return result(C.sope_agent_resume(p)) })
}
func (a *Agent) ToolResult(id uint64, failed bool, text string) error {
	return a.answer(id, failed, text, false)
}
func (a *Agent) Resolve(id uint64, failed bool, text string) error {
	return a.answer(id, failed, text, true)
}
func (a *Agent) answer(id uint64, failed bool, text string, recovery bool) error {
	return a.with(func(p *C.sope_agent_t) error {
		t, f := cstring(text)
		defer f()
		flag := C.int(0)
		if failed {
			flag = 1
		}
		if recovery {
			return result(C.sope_agent_resolve(p, C.uint64_t(id), flag, t, C.size_t(len(text))))
		}
		return result(C.sope_tool_result(p, C.uint64_t(id), flag, t, C.size_t(len(text))))
	})
}
func (a *Agent) Permit(id uint64, allow bool, reason string) error {
	return a.with(func(p *C.sope_agent_t) error {
		t, f := cstring(reason)
		defer f()
		flag := C.int(0)
		if allow {
			flag = 1
		}
		return result(C.sope_permit(p, C.uint64_t(id), flag, t, C.size_t(len(reason))))
	})
}
func (a *Agent) Compact(instructions string) (uint64, error) {
	var id C.uint64_t
	err := a.with(func(p *C.sope_agent_t) error {
		t, f := cstring(instructions)
		defer f()
		return result(C.sope_compact(p, t, C.size_t(len(instructions)), &id))
	})
	return uint64(id), err
}

type Status struct {
	SessionID    string `json:"session_id"`
	InstanceID   string `json:"instance_id"`
	State        string `json:"state"`
	ActiveTurn   uint64 `json:"active_turn,string"`
	LastSequence uint64 `json:"last_sequence,string"`
	Sealed       bool   `json:"sealed"`
}
type Outcome struct {
	TurnID uint64 `json:"turn_id,string"`
	Stop   int    `json:"stop"`
	Final  string `json:"final"`
}
// ContextUsage is sope_agent_context's report; tokens, 0 when unknown.
type ContextUsage struct {
	State     string `json:"state"`
	Used      uint64 `json:"used"`
	Estimate  uint64 `json:"estimate"`
	Window    uint64 `json:"window"`
	Reserve   uint64 `json:"reserve"`
	Threshold uint64 `json:"threshold"`
	Parts     struct {
		System      uint64 `json:"system"`
		Tools       uint64 `json:"tools"`
		Summary     uint64 `json:"summary"`
		Messages    uint64 `json:"messages"`
		ToolResults uint64 `json:"tool_results"`
		Images      uint64 `json:"images"`
	} `json:"parts"`
	Counts struct {
		Tools       int `json:"tools"`
		Messages    int `json:"messages"`
		ToolResults int `json:"tool_results"`
		Images      int `json:"images"`
	} `json:"counts"`
	Largest []struct {
		Name   string `json:"name"`
		Input  string `json:"input,omitempty"`
		Tokens uint64 `json:"tokens"`
	} `json:"largest"`
}

type RecoveryCall struct {
	CallID    uint64   `json:"call_id,string"`
	Name      string   `json:"name"`
	Input     string   `json:"input"`
	Artifacts []string `json:"artifacts"`
}
type Recovery struct {
	Pending bool           `json:"pending"`
	Calls   []RecoveryCall `json:"calls"`
}
type Event struct {
	Sequence uint64 `json:"sequence,string"`
	Type     uint32 `json:"type"`
	AgentID  uint64 `json:"agent_id,string"`
	TurnID   uint64 `json:"turn_id,string"`
	CallID   uint64 `json:"call_id,string"`
	Code     int    `json:"code"`
	Name     string `json:"name"`
	Data     string `json:"data"`
}

const (
	EventTurnStart     = uint32(C.SOPE_EVENT_TURN_START)
	EventLog           = uint32(C.SOPE_EVENT_LOG)
	EventUsage         = uint32(C.SOPE_EVENT_USAGE)
	EventSubagentStart = uint32(C.SOPE_EVENT_SUBAGENT_START)
	EventSubagentEnd   = uint32(C.SOPE_EVENT_SUBAGENT_END)
	EventCompact       = uint32(C.SOPE_EVENT_COMPACT)
	EventText          = uint32(C.SOPE_EVENT_TEXT_DELTA)
	EventThinking      = uint32(C.SOPE_EVENT_THINKING_DELTA)
	EventToolCall      = uint32(C.SOPE_EVENT_TOOL_CALL)
	EventToolStart     = uint32(C.SOPE_EVENT_TOOL_START)
	EventToolEnd       = uint32(C.SOPE_EVENT_TOOL_END)
	EventPermission    = uint32(C.SOPE_EVENT_PERMISSION)
	EventTurnEnd       = uint32(C.SOPE_EVENT_TURN_END)
	EventError         = uint32(C.SOPE_EVENT_ERROR)
	StopEndTurn        = int(C.SOPE_STOP_END_TURN)
	StopCancelled      = int(C.SOPE_STOP_CANCELLED)
	StopError          = int(C.SOPE_STOP_ERROR)
)

func (a *Agent) query(kind int, id uint64, limit uint32, dst any) error {
	return a.queryContext(context.Background(), kind, id, limit, dst)
}
func (a *Agent) queryContext(ctx context.Context, kind int, id uint64, limit uint32, dst any) error {
	return a.withContext(ctx, func(p *C.sope_agent_t) error {
		var raw *C.char
		var size C.size_t
		var rc C.int
		switch kind {
		case 0:
			rc = C.sope_agent_status(p, &raw, &size)
		case 1:
			rc = C.sope_agent_recovery(p, &raw, &size)
		case 2:
			rc = C.sope_agent_events(p, C.uint64_t(id), C.uint32_t(limit), &raw, &size)
		case 3:
			rc = C.sope_agent_outcome(p, C.uint64_t(id), &raw, &size)
		case 4:
			rc = C.sope_agent_history(p, &raw, &size)
		case 5:
			rc = C.sope_agent_context(p, &raw, &size)
		}
		if err := result(rc); err != nil {
			return err
		}
		return json.Unmarshal([]byte(C.GoStringN(raw, C.int(size))), dst)
	})
}
func (a *Agent) Status() (Status, error) { var v Status; err := a.query(0, 0, 0, &v); return v, err }
func (a *Agent) Recovery() (Recovery, error) {
	var v Recovery
	err := a.query(1, 0, 0, &v)
	return v, err
}
func (a *Agent) Events(after uint64, limit uint32) ([]Event, error) {
	var v []Event
	err := a.query(2, after, limit, &v)
	return v, err
}
func (a *Agent) Outcome(turn uint64) (Outcome, error) {
	var v Outcome
	err := a.query(3, turn, 0, &v)
	return v, err
}
func (a *Agent) History() (json.RawMessage, error) {
	var v json.RawMessage
	err := a.query(4, 0, 0, &v)
	return v, err
}

// Context reports how full the model's context is, measured the way
// compaction measures it. While a turn runs it describes the last request.
func (a *Agent) Context() (ContextUsage, error) {
	var v ContextUsage
	err := a.query(5, 0, 0, &v)
	return v, err
}

// Poll permits one consumer. Returned data belongs to Go and survives all later
// calls. A context deadline stops waiting; it does not cancel the turn.
func (a *Agent) Poll(ctx context.Context) (Event, error) {
	if !a.polling.CompareAndSwap(false, true) {
		return Event{}, ErrBusy
	}
	defer a.polling.Store(false)
	for {
		if err := ctx.Err(); err != nil {
			return Event{}, err
		}
		var ev Event
		got := false
		err := a.withContext(ctx, func(p *C.sope_agent_t) error {
			var e C.sope_event_t
			e.size = C.uint32_t(unsafe.Sizeof(e))
			rc := C.sope_poll(p, &e, 20)
			if rc < 0 {
				return result(rc)
			}
			if rc == 0 {
				return nil
			}
			got = true
			ev = Event{uint64(e.sequence), uint32(e._type), uint64(e.agent_id), uint64(e.turn_id), uint64(e.call_id), int(e.code), C.GoStringN(e.name, C.int(e.name_len)), C.GoStringN(e.data, C.int(e.data_len))}
			return nil
		})
		if err != nil || got {
			return ev, err
		}
	}
}
func (a *Agent) Suspend(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := a.withContext(ctx, func(p *C.sope_agent_t) error { return result(C.sope_agent_suspend(p)) }); err != nil {
		return err
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := a.withContext(ctx, func(p *C.sope_agent_t) error { return result(C.sope_agent_wait(p, 20)) })
		var native *Error
		if errors.As(err, &native) && native.Code == Timeout {
			continue
		}
		return err
	}
}

// Close initiates cancellation and release exactly once. If ctx expires, cleanup
// continues under exclusive ownership; the handle is already closed to new calls.
// To preserve unfinished input call Suspend first, then Close. Close is repeatable.
func (a *Agent) Close(ctx context.Context) error {
	if a == nil || a.gate == nil {
		return nil
	}
	a.closeOnce.Do(func() {
		a.closing.Store(true)
		close(a.stopping)
		go func() {
			a.gate <- struct{}{}
			defer func() { <-a.gate }()
			if a.ptr != nil {
				C.sope_agent_free(a.ptr)
				a.ptr = nil
			}
			close(a.closed)
		}()
	})
	select {
	case <-a.closed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// WaitOutcome does not consume events. Hosts must drain Poll concurrently (and
// persist event cursors with their projections) to avoid retaining live events
// in memory. This method never retries or cancels a submitted request.
func (a *Agent) WaitOutcome(ctx context.Context, turn uint64) (Outcome, error) {
	for {
		if err := ctx.Err(); err != nil {
			return Outcome{}, err
		}
		var v Outcome
		err := a.queryContext(ctx, 3, turn, 0, &v)
		if !errors.Is(err, ErrNotFound) {
			return v, err
		}
		select {
		case <-ctx.Done():
			return Outcome{}, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// Version reports the loaded native library version.
func Version() string { return C.GoString(C.sope_version()) }

// SetThreads configures the native worker pool before opening agents.
func SetThreads(n uint32) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	return result(C.sope_set_threads(C.uint32_t(n)))
}

// Shutdown releases shared native workers. All agents must be closed first;
// otherwise it returns ErrBusy. A later Open starts the workers again.
func Shutdown() error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	return result(C.sope_shutdown())
}
