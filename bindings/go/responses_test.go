// SPDX-License-Identifier: MIT
package sope

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func stream(w http.ResponseWriter, events ...any) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, event := range events {
		data, _ := json.Marshal(event)
		fmt.Fprintf(w, "event: ignored\ndata: %s\n\n", data)
	}
}
func completed(items ...any) any {
	return map[string]any{"type": "response.completed", "response": map[string]any{"status": "completed", "output": items, "usage": map[string]int{"input_tokens": 42, "output_tokens": 7}}}
}
func outputText(text string) any {
	return map[string]any{"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}}}
}
func functionCall(id string) any {
	return map[string]any{"type": "function_call", "id": "fc_" + id, "call_id": id, "name": "echo", "arguments": `{"value":"constraint"}`, "status": "completed"}
}
func responseConfig(dir, url string) Config {
	c := config(dir)
	c.Options = map[string]string{"provider": "openai", "openai.wire_api": "responses", "openai.base_url": url, "openai.api_key": "token-before", "model": "test-reasoning", "reasoning.effort": "high"}
	return c
}
func TestResponsesRoundRecovery(t *testing.T) {
	if os.Getenv("SOPE_TEST_HTTP") == "off" {
		t.Skip("HTTP disabled in this build")
	}
	var mu sync.Mutex
	var requests []map[string]any
	var tokens []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" {
			t.Errorf("wrong path %s", r.URL.Path)
		}
		var body map[string]any
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Error(e)
		}
		mu.Lock()
		requests = append(requests, body)
		tokens = append(tokens, r.Header.Get("Authorization"))
		n := len(requests)
		mu.Unlock()
		if n == 1 {
			stream(w, completed(map[string]any{"type": "reasoning", "id": "rs_1", "summary": []any{}, "encrypted_content": "opaque-reasoning-state"}, functionCall("call_1")))
		} else {
			stream(w, map[string]any{"type": "response.output_text.delta", "delta": "goal, constraints and KEY_RESULT preserved"}, completed(outputText("goal, constraints and KEY_RESULT preserved")))
		}
	}))
	defer server.Close()
	cfg := responseConfig(t.TempDir(), server.URL)
	a := openTest(t, cfg)
	id := submit(t, a, "response", "original goal; never modify loom")
	call := until(t, a, EventToolCall)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if e := a.Suspend(ctx); e != nil {
		t.Fatal(e)
	}
	a.Close(ctx)
	cfg.Options["openai.api_key"] = "token-after"
	a = openTest(t, cfg)
	if e := a.Resolve(call.CallID, false, "KEY_RESULT"); e != nil {
		t.Fatal(e)
	}
	if e := a.Resume(); e != nil {
		t.Fatal(e)
	}
	until(t, a, EventTurnEnd)
	out, e := a.Outcome(id)
	if e != nil || out.Final != "goal, constraints and KEY_RESULT preserved" {
		t.Fatal(out, e)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 2 {
		t.Fatal(len(requests))
	}
	b := requests[0]
	if b["store"] != false || b["stream"] != true || b["reasoning"].(map[string]any)["effort"] != "high" {
		t.Fatal(b)
	}
	encoded, _ := json.Marshal(requests[1])
	for _, s := range []string{"original goal; never modify loom", "opaque-reasoning-state", "function_call_output", "KEY_RESULT", "call_1"} {
		if !strings.Contains(string(encoded), s) {
			t.Fatalf("lost %s: %s", s, encoded)
		}
	}
	if tokens[0] != "Bearer token-before" || tokens[1] != "Bearer token-after" {
		t.Fatal(tokens)
	}
}
func TestResponsesInvalidNeverDispatches(t *testing.T) {
	if os.Getenv("SOPE_TEST_HTTP") == "off" {
		t.Skip("HTTP disabled in this build")
	}
	for _, mode := range []string{"truncated", "incomplete", "failed", "text-mismatch", "refusal", "malformed-arguments", "duplicate-call", "unknown-output", "unfinished-item", "missing-reasoning", "duplicate-argument"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch mode {
				case "truncated":
					stream(w, map[string]any{"type": "response.output_item.done", "item": functionCall("a")})
				case "incomplete", "failed":
					stream(w, map[string]any{"type": "response." + mode, "response": map[string]any{"status": mode}})
				case "text-mismatch":
					stream(w, map[string]any{"type": "response.output_text.delta", "delta": "wrong"}, completed(outputText("different"), functionCall("a")))
				case "refusal":
					stream(w, completed(map[string]any{"type": "message", "content": []any{map[string]string{"type": "refusal", "refusal": "denied"}}}, functionCall("a")))
				case "malformed-arguments":
					c := functionCall("a").(map[string]any)
					c["arguments"] = "{"
					stream(w, completed(c))
				case "duplicate-call":
					stream(w, completed(functionCall("a"), functionCall("a")))
				case "duplicate-argument":
					c := functionCall("a").(map[string]any)
					c["arguments"] = `{"value":"unsafe","value":"safe"}`
					stream(w, completed(c))
				case "unfinished-item":
					c := functionCall("a").(map[string]any)
					c["status"] = "in_progress"
					stream(w, completed(c))
				case "missing-reasoning":
					stream(w, completed(map[string]any{"type": "reasoning", "id": "rs", "summary": []any{}}, functionCall("a")))
				case "unknown-output":
					stream(w, completed(map[string]string{"type": "computer_call"}, functionCall("a")))
				}
			}))
			defer server.Close()
			a := openTest(t, responseConfig(t.TempDir(), server.URL))
			id := submit(t, a, "bad", "must not execute")
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			sawError := false
			for {
				ev, e := a.Poll(ctx)
				if e != nil {
					t.Fatal(e)
				}
				if ev.Type == EventToolCall || ev.Type == EventToolStart {
					t.Fatal("dispatched invalid response", ev)
				}
				if ev.Type == EventError {
					sawError = true
				}
				if ev.Type == EventTurnEnd {
					if ev.Code != StopError || !sawError {
						t.Fatal(ev, sawError)
					}
					break
				}
			}
			out, e := a.Outcome(id)
			if e != nil || out.Stop != StopError || out.Final != "" {
				t.Fatal(out, e)
			}
		})
	}
}
func TestResponsesCompactionReplay(t *testing.T) {
	if os.Getenv("SOPE_TEST_HTTP") == "off" {
		t.Skip("HTTP disabled in this build")
	}
	var mu sync.Mutex
	var count int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		count++
		mu.Unlock()
		stream(w, completed(outputText("goal: embed safely; constraint: do not change loom; result: recorded")))
	}))
	defer server.Close()
	cfg := responseConfig(t.TempDir(), server.URL)
	cfg.Options["compact.retain_tokens"] = "0"
	a := openTest(t, cfg)
	for i := 0; i < 3; i++ {
		submit(t, a, fmt.Sprint(i), "goal: embed safely; constraint: do not change loom; result: recorded")
		until(t, a, EventTurnEnd)
		if _, e := a.Compact("retain goal and constraints"); e != nil {
			t.Fatal(e)
		}
		until(t, a, EventTurnEnd)
		a.Close(context.Background())
		a = openTest(t, cfg)
		h, e := a.History()
		if e != nil || !strings.Contains(string(h), "do not change loom") {
			t.Fatal(string(h), e)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if count != 6 {
		t.Fatal(count)
	}
}
