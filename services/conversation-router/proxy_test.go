package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAguiThreadIDReadsBodyAndRestoresIt(t *testing.T) {
	body := `{"threadId":"conv-xyz","messages":[]}`
	r := httptest.NewRequest("POST", "/agui", strings.NewReader(body))

	id := aguiThreadID(r)
	if id != "conv-xyz" {
		t.Fatalf("threadId = %q, want conv-xyz", id)
	}
	// The body must still be fully readable by the upstream proxy afterwards.
	rest, _ := io.ReadAll(r.Body)
	if string(rest) != body {
		t.Errorf("body not restored: got %q, want %q", string(rest), body)
	}
}

func TestAguiThreadIDMissing(t *testing.T) {
	r := httptest.NewRequest("POST", "/agui", strings.NewReader(`{"messages":[]}`))
	if id := aguiThreadID(r); id != "" {
		t.Errorf("no threadId should yield empty, got %q", id)
	}
}

func TestResolveTarget(t *testing.T) {
	cfg := config{namespace: "agent-sandbox", upstreamPort: 8080, clusterIPService: "agent-host"}
	fallback := FallbackURL(cfg.clusterIPService, cfg.namespace, cfg.upstreamPort)
	fb := fallback.String()
	s := newMemStore("conv-assigned", "conv-new")
	s.set("conv-assigned", "pod-a")
	res := liveAssigner(s, pods("pod-a", "10.42.0.2"))
	target := func(r *http.Request) string {
		_, u, err := resolveTargetFor(cfg, res, r, fallback)
		if err != nil {
			t.Fatalf("resolve %s: %v", r.URL.Path, err)
		}
		return u.String()
	}

	if u := target(httptest.NewRequest("GET", "/healthz", nil)); u != fb {
		t.Errorf("healthz -> %q, want fallback %q", u, fb)
	}
	if u := target(httptest.NewRequest("GET", "/conversations/conv-assigned/events.integrity", nil)); u != "http://10.42.0.2:8080" {
		t.Errorf("assigned conv -> %q", u)
	}
	// Unassigned: claimed, never the Service.
	if u := target(httptest.NewRequest("GET", "/conversations/conv-new/cancel", nil)); u != "http://10.42.0.2:8080" {
		t.Errorf("unassigned conv -> %q, want a claimed pod", u)
	}
	if u := target(httptest.NewRequest("GET", "/conversations/conv-unknown/cancel", nil)); u != fb {
		t.Errorf("unknown conv -> %q, want fallback", u)
	}
	req := httptest.NewRequest("POST", "/agui", strings.NewReader(`{"threadId":"conv-assigned"}`))
	if u := target(req); u != "http://10.42.0.2:8080" {
		t.Errorf("agui assigned -> %q", u)
	}
}

func TestResolveTargetPassiveReadLeavesSuspendedUnclaimed(t *testing.T) {
	cfg := config{namespace: "agent-sandbox", upstreamPort: 8080, clusterIPService: "agent-host"}
	fallback := FallbackURL(cfg.clusterIPService, cfg.namespace, cfg.upstreamPort)
	s := newMemStore("conv-s")
	s.suspend("conv-s")
	res := liveAssigner(s, pods("pod-a", "10.42.0.2"))

	for _, path := range []string{"/conversations/conv-s/links", "/conversations/conv-s/shares", "/conversations/conv-s"} {
		_, u, err := resolveTargetFor(cfg, res, httptest.NewRequest("GET", path, nil), fallback)
		if err != nil || u.String() != fallback.String() {
			t.Fatalf("GET %s -> %v %v, want the fallback", path, u, err)
		}
	}
	if s.claims.Load() != 0 {
		t.Fatalf("passive reads claimed a suspended conversation %d times", s.claims.Load())
	}

	// A stream or a write still claims, so the run and its live events share one pod.
	sse := httptest.NewRequest("GET", "/conversations/conv-s/events", nil)
	if _, u, _ := resolveTargetFor(cfg, res, sse, fallback); u.String() != "http://10.42.0.2:8080" {
		t.Fatalf("event stream -> %v, want a claimed pod", u)
	}
	if s.claims.Load() != 1 {
		t.Fatalf("claims = %d, want 1 from the event stream", s.claims.Load())
	}
}

func TestIsPassiveRead(t *testing.T) {
	cases := []struct {
		method, path, hdr, val string
		want                   bool
	}{
		{"GET", "/conversations/c1/links", "", "", true},
		{"HEAD", "/conversations/c1/ready", "", "", true},
		{"POST", "/conversations/c1/resume", "", "", false},
		{"GET", "/conversations/c1/events", "", "", false},
		{"GET", "/conversations/c1/history", "Accept", "text/event-stream", false},
		{"GET", "/conversations/c1/terminal", "Upgrade", "websocket", false},
		{"GET", "/c/c1/marimo/", "", "", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, c.path, nil)
		if c.hdr != "" {
			r.Header.Set(c.hdr, c.val)
		}
		if got := isPassiveRead(r); got != c.want {
			t.Errorf("%s %s (%s=%s) = %v, want %v", c.method, c.path, c.hdr, c.val, got, c.want)
		}
	}
}
