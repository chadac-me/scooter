package main

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// staleUpstream answers the first request on each connection with a keep-alive 200 and
// closes the connection, unanswered, on any later request: an agent-host whose idle
// keep-alive close crossed the router's reuse of the same connection.
func staleUpstream(t *testing.T) (string, func() int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	reached := 0
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				for n := 0; ; n++ {
					req, err := http.ReadRequest(br)
					if err != nil {
						return
					}
					_, _ = io.Copy(io.Discard, req.Body)
					if n > 0 {
						return
					}
					mu.Lock()
					reached++
					mu.Unlock()
					_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
				}
			}(conn)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return "http://" + ln.Addr().String(), func() int { mu.Lock(); defer mu.Unlock(); return reached }
}

// warmPool leaves one idle connection to target in the shared upstream pool.
func warmPool(t *testing.T, target string) {
	t.Helper()
	r := httptest.NewRequest("GET", "/conversations/conv-1/ready", nil)
	w := httptest.NewRecorder()
	serveVia(context.Background(), w, r, mustURL(t, target), mustURL(t, target), false, "conv-1")
	if w.Code != http.StatusOK || w.Body.String() != "ok" {
		t.Fatalf("warm-up: %d %q", w.Code, w.Body.String())
	}
}

// aguiPost is a POST /agui as the router's handler prepares it: body buffered and rewindable.
func aguiPost(body string) *http.Request {
	r := httptest.NewRequest("POST", "/agui", strings.NewReader(body))
	aguiThreadID(r)
	return r
}

// A prompt that dies on a stale owner connection is retried via the fallback, body intact,
// rather than answered with an empty 200 that silently drops it.
func TestStaleOwnerConnectionRetriesPromptViaFallback(t *testing.T) {
	owner, _ := staleUpstream(t)
	var got string
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		_, _ = io.WriteString(w, "data: RUN_STARTED\n\n")
	}))
	defer fallback.Close()

	warmPool(t, owner)
	body := `{"threadId":"conv-1","messages":[{"role":"user","content":"hi"}]}`
	w := httptest.NewRecorder()
	captureJSON(t, func() {
		serveVia(context.Background(), w, aguiPost(body), mustURL(t, owner), mustURL(t, fallback.URL), true, "conv-1")
	})

	if got != body {
		t.Fatalf("fallback received %q, want the prompt body %q", got, body)
	}
	if !strings.Contains(w.Body.String(), "RUN_STARTED") {
		t.Errorf("client got %d %q, want the fallback's stream", w.Code, w.Body.String())
	}
}

// With no retry left, the same failure is a 502, never a 200 with no body.
func TestStaleConnectionWithoutRetryIsBadGateway(t *testing.T) {
	owner, _ := staleUpstream(t)
	warmPool(t, owner)
	w := httptest.NewRecorder()
	captureJSON(t, func() {
		serveVia(context.Background(), w, aguiPost(`{"threadId":"conv-1"}`), mustURL(t, owner), mustURL(t, owner), false, "conv-1")
	})
	if w.Code != http.StatusBadGateway {
		t.Errorf("status = %d body %q, want 502", w.Code, w.Body.String())
	}
}

// A streamed body that cannot be rewound is not replayed to the fallback.
func TestStaleConnectionDoesNotReplayAnUnrewindableBody(t *testing.T) {
	owner, _ := staleUpstream(t)
	fallbackHit := false
	fallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fallbackHit = true }))
	defer fallback.Close()

	warmPool(t, owner)
	r := httptest.NewRequest("POST", "/conversations/conv-1/uploads", io.NopCloser(strings.NewReader("payload")))
	r.GetBody = nil
	w := httptest.NewRecorder()
	captureJSON(t, func() {
		serveVia(context.Background(), w, r, mustURL(t, owner), mustURL(t, fallback.URL), true, "conv-1")
	})
	if fallbackHit {
		t.Error("an unrewindable body was replayed to the fallback")
	}
	if w.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", w.Code)
	}
}

// The router drops idle upstream connections before agent-host's keep-alive closes them.
func TestUpstreamIdleTimeoutIsBelowAgentHostKeepAlive(t *testing.T) {
	if upstreamTransport.IdleConnTimeout <= 0 || upstreamTransport.IdleConnTimeout >= agentHostKeepAlive {
		t.Errorf("IdleConnTimeout = %v, want in (0, %v)", upstreamTransport.IdleConnTimeout, agentHostKeepAlive)
	}
}
