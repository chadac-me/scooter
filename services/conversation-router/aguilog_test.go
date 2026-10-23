package main

import (
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"testing"
)

// A prompt that commits a 200 and streams nothing must read differently from one that
// streamed events, and the line must say whether it went to the owner or the Service.
func TestServeAguiLoggedRecordsRouteAndBytes(t *testing.T) {
	fallback, _ := neturl.Parse("http://agent-host-pods.agent-sandbox.svc:8080")
	owner, _ := neturl.Parse("http://10.42.0.7:8080")

	cases := []struct {
		name      string
		target    *neturl.URL
		body      string
		wantVia   string
		wantBytes float64
	}{
		{"owner, streamed", owner, "data: {\"type\":\"RUN_STARTED\"}\n\n", "owner", 30},
		{"fallback, empty", fallback, "", "fallback", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			lines := captureJSON(t, func() {
				serveAguiLogged(func(w http.ResponseWriter) {
					w.WriteHeader(http.StatusOK)
					if tc.body != "" {
						_, _ = w.Write([]byte(tc.body))
					}
					w.(http.Flusher).Flush()
				}, rr, "conv-1", tc.target, fallback)
			})
			if len(lines) != 1 {
				t.Fatalf("want 1 line, got %d: %v", len(lines), lines)
			}
			l := lines[0]
			if l["msg"] != "agui routed" || l["conversation_id"] != "conv-1" || l["via"] != tc.wantVia ||
				l["upstream"] != tc.target.Host || l["status"] != float64(200) || l["bytes"] != tc.wantBytes {
				t.Fatalf("unexpected line: %v", l)
			}
			if !rr.Flushed {
				t.Fatal("Flush did not pass through to the client")
			}
		})
	}
}
