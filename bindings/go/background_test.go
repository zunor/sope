// SPDX-License-Identifier: MIT
package sope

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestBackgroundCompletionWaitsWithoutModelPolling(t *testing.T) {
	if os.Getenv("SOPE_TEST_HTTP") == "off" {
		t.Skip("HTTP disabled")
	}
	dir := t.TempDir()
	gate := filepath.Join(dir, "gate")
	var requests atomic.Int32
	waiting := make(chan struct{})
	var received atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		n := requests.Add(1)
		switch n {
		case 1:
			args, _ := json.Marshal(map[string]any{"command": "while [ ! -f gate ]; do sleep 0.02; done; echo completed-proof; exit 7", "run_in_background": true})
			stream(w, completed(map[string]any{"type": "function_call", "id": "fc_bg", "call_id": "bg", "name": "bash", "arguments": string(args), "status": "completed"}))
		case 2:
			stream(w, completed(outputText("Waiting for the background command.")))
			close(waiting)
		default:
			received.Store(strings.Contains(string(body), "Background shell 1 completed (exit code 7)") && strings.Contains(string(body), "completed-proof"))
			stream(w, completed(outputText("Observed command failure; no rerun.")))
		}
	}))
	defer server.Close()
	cfg := responseConfig(filepath.Join(dir, "session"), server.URL)
	cfg.Options["permissions"] = "allow"
	cfg.Options["cwd"] = dir
	a := openTest(t, cfg)
	id := submit(t, a, "background", "Run the command")
	select {
	case <-waiting:
	case <-time.After(5 * time.Second):
		t.Fatal("model never reached wait")
	}
	time.Sleep(100 * time.Millisecond)
	if requests.Load() != 2 {
		t.Fatal("model polled while waiting", requests.Load())
	}
	if err := os.WriteFile(gate, nil, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := a.WaitOutcome(ctx, id)
	if err != nil || out.Stop != StopEndTurn {
		t.Fatal(out, err)
	}
	if requests.Load() != 3 || !received.Load() {
		t.Fatal("missing completion or duplicate requests", requests.Load())
	}
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
	a = openTest(t, cfg)
	got, err := a.Outcome(id)
	if err != nil || got.Final != out.Final {
		t.Fatal("completion did not survive reopen", got, err)
	}
	if requests.Load() != 3 {
		t.Fatal("reopening replayed execution")
	}
}
