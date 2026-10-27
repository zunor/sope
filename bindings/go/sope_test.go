// SPDX-License-Identifier: MIT
package sope

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func config(dir string) Config {
	return Config{Directory: dir, Revision: "executor-v1", EnvironmentRevision: "env-v1", Options: map[string]string{"provider": "mock", "mock.delay_ms": "0"}, Policy: Policy{Tools: []string{"echo", "bash", "read", "agent"}, Environment: map[string]string{"PATH": "/usr/bin:/bin"}}, Tools: []Tool{{"echo", "echo", json.RawMessage(`{"type":"object","properties":{"value":{"type":"string"}}}`)}}}
}
func openTest(t *testing.T, c Config) *Agent {
	t.Helper()
	a, e := Open(c)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := a.Close(ctx); e != nil {
			t.Error(e)
		}
	})
	return a
}
func until(t *testing.T, a *Agent, kind uint32) Event {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	for {
		e, err := a.Poll(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if e.Type == EventError {
			t.Fatalf("native error: %s", e.Data)
		}
		if e.Type == kind {
			return e
		}
	}
}
func submit(t *testing.T, a *Agent, key, text string) uint64 {
	t.Helper()
	id, e := a.Submit(key, text)
	if e != nil {
		t.Fatal(e)
	}
	return id
}
func TestReceiptsReplayAndSeal(t *testing.T) {
	cfg := config(t.TempDir())
	a := openTest(t, cfg)
	before, _ := a.Status()
	evidence, err := a.Evidence()
	if err != nil || evidence.SessionID != before.SessionID || evidence.Retention != 32 || len(evidence.Receipts) != 0 {
		t.Fatal(evidence, err)
	}
	id := submit(t, a, "req-1", "preserve target and constraints")
	if got := submit(t, a, "req-1", "preserve target and constraints"); got != id {
		t.Fatal("duplicate ID")
	}
	if _, e := a.Submit("req-1", "different"); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	end := until(t, a, EventTurnEnd)
	if end.Code != StopEndTurn {
		t.Fatal(end)
	}
	outcome, e := a.Outcome(id)
	if e != nil || !strings.Contains(outcome.Final, "preserve target") {
		t.Fatal(outcome, e)
	}
	events, e := a.Events(0, 256)
	if e != nil {
		t.Fatal(e)
	}
	var last uint64
	ends := 0
	for _, ev := range events {
		if ev.Sequence <= last {
			t.Fatal("non-monotonic replay")
		}
		last = ev.Sequence
		if ev.Type == EventTurnEnd {
			ends++
			if ev.Sequence != end.Sequence {
				t.Fatal("live/replay cursor mismatch")
			}
		}
	}
	if ends != 1 {
		t.Fatal(events)
	}
	if e := a.Close(context.Background()); e != nil {
		t.Fatal(e)
	}
	cfg.Options["openai.api_key"] = "rotated-credential"
	a = openTest(t, cfg)
	after, _ := a.Status()
	if after.SessionID != before.SessionID || after.InstanceID == before.InstanceID {
		t.Fatal(before, after)
	}
	if got := submit(t, a, "req-1", "preserve target and constraints"); got != id {
		t.Fatal("receipt lost")
	}
	if _, e := a.Outcome(id); e != nil {
		t.Fatal(e)
	}
	a.Close(context.Background())
	cfg.Revision = "changed-executor"
	if bad, e := Open(cfg); !errors.Is(e, ErrConflict) {
		if bad != nil {
			bad.Close(context.Background())
		}
		t.Fatal(e)
	}
	bytes, e := os.ReadFile(filepath.Join(cfg.Directory, "execution.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(bytes), "rotated-credential") {
		t.Fatal("credential persisted")
	}
}
func TestConcurrentSubmit(t *testing.T) {
	a := openTest(t, config(t.TempDir()))
	var wg sync.WaitGroup
	ids := make(chan uint64, 32)
	errs := make(chan error, 32)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); id, e := a.Submit("one", "exactly one input"); ids <- id; errs <- e }()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	for id := range ids {
		if id != 1 {
			t.Fatal(id)
		}
	}
	until(t, a, EventTurnEnd)
	events, _ := a.Events(0, 256)
	ends := 0
	for _, e := range events {
		if e.Type == EventTurnEnd {
			ends++
		}
	}
	if ends != 1 {
		t.Fatal(ends)
	}
}
func TestPolicyExternalAuthorization(t *testing.T) {
	cfg := config(t.TempDir())
	cfg.Policy.Authorize = true
	cfg.Policy.External = []string{"bash"}
	a := openTest(t, cfg)
	id := submit(t, a, "external", `!bash {"command":"must never execute in the host process"}`)
	permission := until(t, a, EventPermission)
	if e := a.ToolResult(permission.CallID, false, "bypass"); !errors.Is(e, ErrNotFound) {
		t.Fatal("bypassed authorization", e)
	}
	if e := a.Permit(permission.CallID, true, ""); e != nil {
		t.Fatal(e)
	}
	call := until(t, a, EventToolCall)
	if call.Name != "bash" {
		t.Fatal(call)
	}
	if e := a.ToolResult(call.CallID, false, "sandbox result"); e != nil {
		t.Fatal(e)
	}
	until(t, a, EventTurnEnd)
	out, _ := a.Outcome(id)
	if !strings.Contains(out.Final, "sandbox result") {
		t.Fatal(out)
	}
	for i, prompt := range []string{`!echo {"value":"protected"}`, `!read {"file_path":"/never-readable"}`, `!agent:general-purpose secret`} {
		submit(t, a, fmt.Sprint(i), prompt)
		gate := until(t, a, EventPermission)
		if e := a.Permit(gate.CallID, false, "policy"); e != nil {
			t.Fatal(e)
		}
		until(t, a, EventTurnEnd)
	}
}
func TestEmptyAllowlist(t *testing.T) {
	cfg := config(t.TempDir())
	cfg.Policy.Tools = []string{}
	a := openTest(t, cfg)
	submit(t, a, "deny", `!bash {"command":"exit 33"}`)
	until(t, a, EventTurnEnd)
	events, _ := a.Events(0, 256)
	for _, e := range events {
		if e.Type == EventToolCall || e.Type == EventToolStart || e.Type == EventPermission {
			t.Fatal(e)
		}
	}
}
func TestEnvironmentIsolation(t *testing.T) {
	t.Setenv("SOPE_EMBED_SECRET", "host-secret-must-not-leak")
	cfg := config(t.TempDir())
	cfg.Options["permissions"] = "allow"
	cfg.Policy.Environment["LOCAL_VALUE"] = "agent-value"
	a := openTest(t, cfg)
	id := submit(t, a, "env", `!bash {"command":"printf '%s|%s' \"$SOPE_EMBED_SECRET\" \"$LOCAL_VALUE\""}`)
	until(t, a, EventTurnEnd)
	out, _ := a.Outcome(id)
	if strings.Contains(out.Final, "host-secret") || !strings.Contains(out.Final, "|agent-value") {
		t.Fatal(out)
	}
}
func TestSuspendReconcileRepeated(t *testing.T) {
	cfg := config(t.TempDir())
	a := openTest(t, cfg)
	for i := 0; i < 3; i++ {
		id := submit(t, a, fmt.Sprint(i), `!echo {"value":"side effect"}`)
		call := until(t, a, EventToolCall)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		e := a.Suspend(ctx)
		cancel()
		if e != nil {
			t.Fatal(e)
		}
		if _, e := a.Outcome(id); !errors.Is(e, ErrNotFound) {
			t.Fatal("suspend completed input", e)
		}
		if e := a.Resume(); !errors.Is(e, ErrBusy) {
			t.Fatal("unknown effect replayed", e)
		}
		recovery, e := a.Recovery()
		if e != nil || !recovery.Pending || len(recovery.Calls) != 1 || recovery.Calls[0].CallID != call.CallID {
			t.Fatal(recovery, e)
		}
		a.Close(context.Background())
		a = openTest(t, cfg)
		if e := a.Resolve(call.CallID, false, "confirmed once"); e != nil {
			t.Fatal(e)
		}
		if e := a.Resume(); e != nil {
			t.Fatal(e)
		}
		until(t, a, EventTurnEnd)
		out, _ := a.Outcome(id)
		if !strings.Contains(out.Final, "confirmed once") {
			t.Fatal(out)
		}
	}
}
func TestSuspendWaitDeadlineAndClose(t *testing.T) {
	cfg := config(t.TempDir())
	cfg.Options["permissions"] = "allow"
	a := openTest(t, cfg)
	submit(t, a, "slow", `!bash {"command":"sleep 0.3; printf drained"}`)
	until(t, a, EventToolStart)
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	e := a.Suspend(ctx)
	if e != nil && !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal(e)
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel2()
	if e := a.Suspend(ctx2); e != nil {
		t.Fatal(e)
	}
	recovery, e := a.Recovery()
	if e != nil || len(recovery.Calls) != 0 {
		t.Fatal(recovery, e)
	}
	if e := a.Resume(); e != nil {
		t.Fatal(e)
	}
	until(t, a, EventTurnEnd)
	submit(t, a, "host", `!echo {}`)
	until(t, a, EventToolCall)
	expired, c := context.WithCancel(context.Background())
	c()
	_ = a.Close(expired)
	if _, e := a.Submit("late", "late"); !errors.Is(e, ErrClosed) {
		t.Fatal(e)
	}
	if e := a.Close(ctx2); e != nil {
		t.Fatal(e)
	}
	b := openTest(t, cfg)
	out, e := b.Outcome(2)
	if e != nil || out.Stop != StopCancelled {
		t.Fatal(out, e)
	}
}
func TestPollOwnershipAndCopy(t *testing.T) {
	a := openTest(t, config(t.TempDir()))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, e := a.Poll(ctx); done <- e }()
	for !a.polling.Load() {
		time.Sleep(time.Millisecond)
	}
	if _, e := a.Poll(ctx); !errors.Is(e, ErrBusy) {
		t.Fatal(e)
	}
	cancel()
	<-done
	submit(t, a, "copy", `!echo {"value":"owned string"}`)
	call := until(t, a, EventToolCall)
	copied := call.Data
	a.ToolResult(call.CallID, false, "ok")
	until(t, a, EventTurnEnd)
	if call.Data != copied || !strings.Contains(call.Data, "owned string") {
		t.Fatal(call)
	}
}
func TestCrashChild(t *testing.T) {
	dir := os.Getenv("SOPE_TEST_CRASH_DIR")
	if dir == "" {
		return
	}
	a, e := Open(config(dir))
	if e != nil {
		panic(e)
	}
	id, e := a.Submit("crash-key", `!echo {"value":"must reconcile"}`)
	if e != nil {
		panic(e)
	}
	stage := os.Getenv("SOPE_TEST_CRASH_STAGE")
	if stage != "admit" {
		for {
			ev, e := a.Poll(context.Background())
			if e != nil {
				panic(e)
			}
			if ev.Type == EventToolCall {
				if stage == "intent" {
					break
				}
				if stage == "resolved" {
					if e = a.Suspend(context.Background()); e != nil {
						panic(e)
					}
					if e = a.Resolve(ev.CallID, false, "committed receipt"); e != nil {
						panic(e)
					}
					break
				}
				if e = a.ToolResult(ev.CallID, false, "committed receipt"); e != nil {
					panic(e)
				}
			}
			if ev.Type == EventTurnEnd {
				if _, e = a.Outcome(id); e != nil {
					panic(e)
				}
				break
			}
		}
	}
	fmt.Println("READY")
	select {}
}
func TestSIGKILLBoundaries(t *testing.T) {
	for _, stage := range []string{"admit", "intent", "resolved", "terminal"} {
		t.Run(stage, func(t *testing.T) {
			dir := t.TempDir()
			cmd := exec.Command(os.Args[0], "-test.run=^TestCrashChild$")
			cmd.Env = append(os.Environ(), "SOPE_TEST_CRASH_DIR="+dir, "SOPE_TEST_CRASH_STAGE="+stage)
			stdout, e := cmd.StdoutPipe()
			if e != nil {
				t.Fatal(e)
			}
			cmd.Stderr = os.Stderr
			if e = cmd.Start(); e != nil {
				t.Fatal(e)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill() })
			ready := make(chan bool, 1)
			go func() {
				s := bufio.NewScanner(stdout)
				for s.Scan() {
					if s.Text() == "READY" {
						ready <- true
						return
					}
				}
				ready <- false
			}()
			select {
			case ok := <-ready:
				if !ok {
					t.Fatal("child exited")
				}
			case <-time.After(8 * time.Second):
				t.Fatal("child timeout")
			}
			if e = cmd.Process.Signal(syscall.SIGKILL); e != nil {
				t.Fatal(e)
			}
			_ = cmd.Wait()
			a := openTest(t, config(dir))
			if got := submit(t, a, "crash-key", `!echo {"value":"must reconcile"}`); got != 1 {
				t.Fatal(got)
			}
			if stage == "terminal" {
				out, e := a.Outcome(1)
				if e != nil || !strings.Contains(out.Final, "committed receipt") {
					t.Fatal(out, e)
				}
			} else {
				r, e := a.Recovery()
				if e != nil || !r.Pending {
					t.Fatal(r, e)
				}
				if stage == "resolved" && len(r.Calls) != 0 {
					t.Fatal("committed recovery receipt lost", r)
				}
				for _, c := range r.Calls {
					if e := a.Resolve(c.CallID, false, "verified after kill"); e != nil {
						t.Fatal(e)
					}
				}
				if e := a.Resume(); e != nil {
					t.Fatal(e)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
				defer cancel()
				for {
					ev, e := a.Poll(ctx)
					if e != nil {
						t.Fatal(e)
					}
					if ev.Type == EventToolCall {
						if stage == "intent" || stage == "resolved" {
							t.Fatal("replayed interrupted tool")
						}
						a.ToolResult(ev.CallID, false, "new execution")
					}
					if ev.Type == EventError {
						t.Fatal(ev.Data)
					}
					if ev.Type == EventTurnEnd {
						break
					}
				}
			}
			events, e := a.Events(0, 256)
			if e != nil {
				t.Fatal(e)
			}
			ends, toolEnds := 0, 0
			for _, ev := range events {
				if ev.Type == EventToolEnd {
					toolEnds++
				}
				if ev.Type == EventTurnEnd {
					ends++
				}
			}
			if ends != 1 || toolEnds != 1 {
				t.Fatal("terminal/receipt completion not atomic", ends, toolEnds)
			}
		})
	}
}
func TestLongOutputAndCompaction(t *testing.T) {
	dir := t.TempDir()
	a := openTest(t, config(dir))
	for i := 0; i < 3; i++ {
		submit(t, a, fmt.Sprint(i), `!echo {"value":"original target, do not delete"}`)
		call := until(t, a, EventToolCall)
		large := "KEY_RESULT_BEGIN\n" + strings.Repeat("abcd", 200000) + "\nKEY_RESULT_END"
		if e := a.ToolResult(call.CallID, false, large); e != nil {
			t.Fatal(e)
		}
		until(t, a, EventTurnEnd)
		found := false
		_ = filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
			if err == nil && !entry.IsDir() {
				data, _ := os.ReadFile(path)
				if string(data) == large {
					found = true
				}
			}
			return nil
		})
		if !found {
			t.Fatal("full output archive missing")
		}
		if _, e := a.Compact("retain target, constraints and artifact paths"); e != nil {
			t.Fatal(e)
		}
		until(t, a, EventTurnEnd)
	}
}

func TestReplayPreservesNUL(t *testing.T) {
	a := openTest(t, config(t.TempDir()))
	id := submit(t, a, "nul", "prefix\x00suffix")
	until(t, a, EventTurnEnd)
	outcome, e := a.Outcome(id)
	if e != nil || !strings.Contains(outcome.Final, "prefix\x00suffix") {
		t.Fatal(outcome, e)
	}
	events, e := a.Events(0, 256)
	if e != nil {
		t.Fatal(e)
	}
	var text string
	for _, ev := range events {
		if ev.Type == EventText {
			text += ev.Data
		}
	}
	if !strings.Contains(text, "prefix\x00suffix") {
		t.Fatal("NUL lost in replay", text)
	}
}
func TestSuspendedSubagentRequiresReconciliation(t *testing.T) {
	cfg := config(t.TempDir())
	cfg.Options["mock.delay_ms"] = "10"
	a := openTest(t, cfg)
	submit(t, a, "child", `!agent:general-purpose !echo {"value":"child effect"}`)
	call := until(t, a, EventToolCall)
	if call.AgentID == 0 {
		t.Fatal(call)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if e := a.Suspend(ctx); e != nil {
		t.Fatal(e)
	}
	recovery, e := a.Recovery()
	if e != nil || len(recovery.Calls) != 1 || recovery.Calls[0].Name != "echo" || recovery.Calls[0].AgentID != call.AgentID || len(recovery.Delegations) != 1 {
		t.Fatal(recovery, e)
	}
	if e := a.Resume(); !errors.Is(e, ErrBusy) {
		t.Fatal(e)
	}
	if e := a.Resolve(call.AgentID, false, "fabricated child completion"); !errors.Is(e, ErrNotFound) {
		t.Fatal(e)
	}
	if e := a.Resolve(recovery.Calls[0].CallID, false, "subagent effects checked"); e != nil {
		t.Fatal(e)
	}
	if e := a.Resume(); e != nil {
		t.Fatal(e)
	}
	until(t, a, EventTurnEnd)
}

func TestLargeReconciledOutputArchive(t *testing.T) {
	dir := t.TempDir()
	a := openTest(t, config(dir))
	id := submit(t, a, "recover-large", `!echo {}`)
	call := until(t, a, EventToolCall)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if e := a.Suspend(ctx); e != nil {
		t.Fatal(e)
	}
	large := strings.Repeat("x", 600000) + "KEY_RESULT_IN_ARCHIVE" + strings.Repeat("y", 600000)
	if e := a.Resolve(call.CallID, false, large); e != nil {
		t.Fatal(e)
	}
	if e := a.Resume(); e != nil {
		t.Fatal(e)
	}
	until(t, a, EventTurnEnd)
	out, e := a.Outcome(id)
	if e != nil || len(out.Final) >= len(large) {
		t.Fatal("reconciled output was not bounded", e)
	}
	found := false
	_ = filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			data, _ := os.ReadFile(path)
			if string(data) == large {
				found = true
			}
		}
		return nil
	})
	if !found {
		t.Fatal("reconciled output archive missing")
	}
}

func TestManualCompactionPublishesAtomicOutcome(t *testing.T) {
	cfg := config(t.TempDir())
	a := openTest(t, cfg)
	submit(t, a, "goal", "keep the original goal and constraints")
	until(t, a, EventTurnEnd)
	id, e := a.Compact("preserve constraints")
	if e != nil {
		t.Fatal(e)
	}
	compact := until(t, a, EventCompact)
	// The host can exit immediately upon this notification: completion must
	// already be durable, not dependent on the next worker scheduling slice.
	outcome, e := a.Outcome(id)
	if e != nil || outcome.Stop != StopEndTurn {
		t.Fatal(outcome, e)
	}
	events, e := a.Events(compact.Sequence-1, 2)
	if e != nil || len(events) != 2 || events[0].Type != EventCompact || events[1].Type != EventTurnEnd {
		t.Fatal(events, e)
	}
	end := until(t, a, EventTurnEnd)
	if end.Sequence != events[1].Sequence {
		t.Fatal(end, events)
	}
	a.Close(context.Background())
	a = openTest(t, cfg)
	r, e := a.Recovery()
	if e != nil || r.Pending {
		t.Fatal(r, e)
	}
}

// A native operation may own the handle while doing synchronous I/O. Hold that
// ownership deterministically to check callers waiting behind it, including close.
func TestContendedWaitsAndClose(t *testing.T) {
	a := openTest(t, config(t.TempDir()))
	a.gate <- struct{}{}
	locked := true
	defer func() {
		if locked {
			<-a.gate
		}
	}()
	for name, wait := range map[string]func(context.Context) error{
		"poll":    func(ctx context.Context) error { _, e := a.Poll(ctx); return e },
		"suspend": a.Suspend,
		"outcome": func(ctx context.Context) error { _, e := a.WaitOutcome(ctx, 1); return e },
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- wait(ctx) }()
			select {
			case err := <-done:
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("context ignored while waiting for native ownership")
			}
		})
	}
	waiting := make(chan error, 1)
	go func() { _, e := a.Submit("blocked", "never admitted"); waiting <- e }()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if e := a.Close(ctx); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal(e)
	}
	select {
	case e := <-waiting:
		if !errors.Is(e, ErrClosed) {
			t.Fatal(e)
		}
	case <-time.After(time.Second):
		t.Fatal("close did not release waiting caller")
	}
	<-a.gate
	locked = false
	if e := a.Close(context.Background()); e != nil {
		t.Fatal(e)
	}
}

func TestSuspendDiscardsStaleCommands(t *testing.T) {
	for _, authorize := range []bool{false, true} {
		t.Run(fmt.Sprint(authorize), func(t *testing.T) {
			cfg := config(t.TempDir())
			cfg.Policy.Authorize = authorize
			a := openTest(t, cfg)
			id := submit(t, a, "queued-command", `!echo {}`)
			kind := EventToolCall
			if authorize {
				kind = EventPermission
			}
			// Observe the durable command without consuming the live queue.
			var call uint64
			deadline := time.Now().Add(3 * time.Second)
			for call == 0 && time.Now().Before(deadline) {
				events, err := a.Events(0, 256)
				if err != nil {
					t.Fatal(err)
				}
				for _, e := range events {
					if e.Type == kind {
						call = e.CallID
					}
				}
				if call == 0 {
					time.Sleep(time.Millisecond)
				}
			}
			if call == 0 {
				t.Fatal("command not issued")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := a.Suspend(ctx); err != nil {
				t.Fatal(err)
			}
			drain, stop := context.WithTimeout(ctx, 40*time.Millisecond)
			defer stop()
			for {
				e, err := a.Poll(drain)
				if errors.Is(err, context.DeadlineExceeded) {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				if e.Type == EventToolCall || e.Type == EventPermission {
					t.Fatal("stale command", e)
				}
			}
			if err := a.Resolve(call, true, "host verified operation never started"); err != nil {
				t.Fatal(err)
			}
			completion := until(t, a, EventToolEnd)
			if completion.CallID != call || completion.Sequence == 0 {
				t.Fatal(completion)
			}
			if err := a.Resume(); err != nil {
				t.Fatal(err)
			}
			until(t, a, EventTurnEnd)
			out, err := a.Outcome(id)
			if err != nil || out.Stop != StopEndTurn {
				t.Fatal(out, err)
			}
			events, _ := a.Events(0, 256)
			ends := 0
			for _, e := range events {
				if e.Type == EventToolEnd && e.CallID == call {
					ends++
					if e.Sequence != completion.Sequence {
						t.Fatal(e)
					}
				}
			}
			if ends != 1 {
				t.Fatal("reconciled receipt needs exactly one completion", ends)
			}
		})
	}
}

func TestConcurrentToolReceipts(t *testing.T) {
	a := openTest(t, config(t.TempDir()))
	submit(t, a, "one", `!echo {}`)
	call := until(t, a, EventToolCall)
	var wg sync.WaitGroup
	results := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- a.ToolResult(call.CallID, false, "single receipt") }()
	}
	wg.Wait()
	close(results)
	success := 0
	for e := range results {
		if e == nil {
			success++
		} else if !errors.Is(e, ErrNotFound) {
			t.Fatal(e)
		}
	}
	if success != 1 {
		t.Fatal(success)
	}
	until(t, a, EventTurnEnd)
	events, err := a.Events(0, 256)
	if err != nil {
		t.Fatal(err)
	}
	ends := 0
	for _, e := range events {
		if e.Type == EventToolEnd && e.CallID == call.CallID {
			ends++
		}
	}
	if ends != 1 {
		t.Fatal(ends)
	}
}

func TestCancelledCompletionSequence(t *testing.T) {
	a := openTest(t, config(t.TempDir()))
	submit(t, a, "cancel", `!echo {}`)
	call := until(t, a, EventToolCall)
	if e := a.Cancel(); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	last, ends := call.Sequence, 0
	for {
		e, err := a.Poll(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if e.Sequence <= last {
			t.Fatalf("out of order: %d then %+v", last, e)
		}
		last = e.Sequence
		if e.Type == EventToolEnd {
			ends++
		}
		if e.Type == EventTurnEnd {
			if e.Code != StopCancelled {
				t.Fatal(e)
			}
			break
		}
	}
	if ends != 1 {
		t.Fatal(ends)
	}
}

func TestDurableChildCompaction(t *testing.T) {
	cfg := config(t.TempDir())
	cfg.Options["compact.threshold"] = "12"
	a := openTest(t, cfg)
	submit(t, a, "child-compact", `!agent:general-purpose !echo {}`)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	last, childCompacts, childEnds := uint64(0), 0, 0
	for {
		e, err := a.Poll(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if e.Type == EventError {
			t.Fatal(e)
		}
		if e.Sequence <= last {
			t.Fatalf("out of order: %d then %+v", last, e)
		}
		last = e.Sequence
		if e.Type == EventToolCall {
			if err := a.ToolResult(e.CallID, false, "child evidence"); err != nil {
				t.Fatal(err)
			}
		}
		if e.Type == EventCompact && e.AgentID != 0 {
			childCompacts++
		}
		if e.Type == EventSubagentEnd {
			childEnds++
		}
		if e.Type == EventTurnEnd && e.AgentID == 0 {
			if e.Code != StopEndTurn {
				t.Fatal(e)
			}
			break
		}
	}
	if childCompacts == 0 || childEnds != 1 {
		t.Fatal(childCompacts, childEnds)
	}
	events, err := a.Events(0, 256)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || events[len(events)-1].Sequence != last {
		t.Fatal("live/replay mismatch")
	}
}

func TestContext(t *testing.T) {
	a := openTest(t, config(t.TempDir()))
	empty, err := a.Context()
	if err != nil {
		t.Fatal(err)
	}
	if empty.State != "idle" || empty.Parts.Messages != 0 || empty.Counts.Tools == 0 || empty.Used != empty.Estimate {
		t.Fatalf("empty context: %+v", empty)
	}
	submit(t, a, "k1", "hello")
	until(t, a, EventTurnEnd)
	after, err := a.Context()
	if err != nil {
		t.Fatal(err)
	}
	p := after.Parts
	if sum := p.System + p.Tools + p.Summary + p.Messages + p.ToolResults + p.Images; sum != after.Estimate || after.Counts.Messages != 2 {
		t.Fatalf("context after a turn: %+v", after)
	}
}
