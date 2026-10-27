// SPDX-License-Identifier: MIT
package sope

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Real TCP resets/EOF must wake the provider immediately, even with the default
// multi-minute timeouts. Committed tools survive; a partial batch never runs.
func TestDisconnectedStreamRecoversWithoutReplayingTools(t *testing.T) {
	if os.Getenv("SOPE_TEST_HTTP") == "off" {
		t.Skip("HTTP disabled")
	}
	for _, reset := range []bool{false, true} {
		t.Run(fmt.Sprintf("reset=%v", reset), func(t *testing.T) {
			dir := t.TempDir()
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				switch requests.Add(1) {
				case 1:
					fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"once\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"command\\\":\\\"printf once >> proof\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
				case 2:
					conn, rw, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					defer conn.Close()
					// Advertise a longer body, then break the actual transport.
					fmt.Fprint(rw, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 100000\r\n\r\n")
					fmt.Fprint(rw, "data: {\"choices\":[{\"delta\":{\"content\":\"discarded-fragment\",\"tool_calls\":[{\"index\":0,\"id\":\"bad\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"command\\\":\\\"touch bad\\\"}\"}}]},\"finish_reason\":null}]}\n\n")
					if err := rw.Flush(); err != nil {
						t.Error(err)
					}
					if reset {
						if err := conn.(*net.TCPConn).SetLinger(0); err != nil {
							t.Error(err)
						}
					}
				default:
					if strings.Contains(string(body), "discarded-fragment") {
						t.Error("partial response leaked into retry history")
					}
					fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"recovered\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
				}
			}))
			defer server.Close()
			cfg := config(filepath.Join(dir, "session"))
			cfg.Options = map[string]string{"provider": "openai", "model": "fixture", "openai.base_url": server.URL,
				"openai.retry_delay_ms": "10", "permissions": "allow", "cwd": dir}
			a := openTest(t, cfg)
			start := time.Now()
			id := submit(t, a, "disconnect", "Run once, then recover")
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			retries := 0
			for {
				ev, err := a.Poll(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if ev.Type == EventError {
					t.Fatal(ev.Data)
				}
				if ev.Type == EventModelRetry {
					retries++
					if ev.Name != "transport" {
						t.Fatalf("expected transport recovery, got %s", ev.Name)
					}
				}
				if ev.Type == EventTurnEnd {
					break
				}
			}
			out, err := a.Outcome(id)
			if err != nil || out.Stop != StopEndTurn || !strings.Contains(out.Final, "recovered") {
				t.Fatal(out, err)
			}
			if requests.Load() != 3 || retries != 1 {
				t.Fatal("unexpected replay/retry", requests.Load(), retries)
			}
			if got, err := os.ReadFile(filepath.Join(dir, "proof")); err != nil || string(got) != "once" {
				t.Fatal(string(got), err)
			}
			if _, err := os.Stat(filepath.Join(dir, "bad")); !os.IsNotExist(err) {
				t.Fatal("partial batch executed", err)
			}
			t.Logf("transport recovered with committed tool executed once in %s", time.Since(start))
		})
	}
}
