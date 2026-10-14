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
