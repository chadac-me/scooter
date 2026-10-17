package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSandboxLabel(t *testing.T) {
	cases := []struct {
		host, domain, want string
		ok                 bool
	}{
		{"5a515e73.scooter.example.com", "scooter.example.com", "5a515e73", true},
		{"5a515e73.scooter.example.com:443", "scooter.example.com", "5a515e73", true},
		{"5A515E73.Scooter.Example.com.", "scooter.example.com", "5a515e73", true},
		{"5a515e73-860b.scooter.example.com", "scooter.example.com", "5a515e73-860b", true},
		// Disabled, the main host, other domains, nested names.
		{"5a515e73.scooter.example.com", "", "", false},
		{"scooter.example.com", "scooter.example.com", "", false},
		{"5a515e73.other.example.com", "scooter.example.com", "", false},
		{"x.5a515e73.scooter.example.com", "scooter.example.com", "", false},
		// Not a conversation label: too short, non-hex, a hyphen at an edge.
		{"5a515e7.scooter.example.com", "scooter.example.com", "", false},
		{"grafana1.scooter.example.com", "scooter.example.com", "", false},
		{"5a515e73-.scooter.example.com", "scooter.example.com", "", false},
	}
	for _, c := range cases {
		got, ok := SandboxLabel(c.host, c.domain)
		if got != c.want || ok != c.ok {
			t.Errorf("SandboxLabel(%q, %q) = (%q, %v), want (%q, %v)", c.host, c.domain, got, ok, c.want, c.ok)
		}
	}
}

type fakeLabels map[string][]string

func (f fakeLabels) ConversationByLabel(_ context.Context, label string) (string, bool, error) {
	ids := f[label]
	switch len(ids) {
	case 0:
		return "", false, nil
	case 1:
		return ids[0], true, nil
	}
	return "", false, ErrAmbiguousLabel
}

func TestRewriteSandboxRequest(t *testing.T) {
	const id = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff"
	labels := fakeLabels{"5a515e73": {id}, "aaaaaaaa": {"aaaaaaaa-1", "aaaaaaaa-2"}}

	r := httptest.NewRequest("GET", "http://5a515e73.scooter.example.com/marimo/assets/x.js?v=1", nil)
	w := httptest.NewRecorder()
	if !rewriteSandboxRequest(w, r, "5a515e73", labels) {
		t.Fatalf("rewrite refused: %d %s", w.Code, w.Body)
	}
	if want := "/c/" + id + "/marimo/assets/x.js"; r.URL.Path != want {
		t.Errorf("path = %q, want %q", r.URL.Path, want)
	}
	if r.URL.RawQuery != "v=1" {
		t.Errorf("query = %q, want v=1", r.URL.RawQuery)
	}
	if r.Header.Get(SandboxHostHeader) != "5a515e73" {
		t.Errorf("missing %s", SandboxHostHeader)
	}
	if id, ok := ConvIDFromPath(r.URL.Path); !ok || id != "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff" {
		t.Errorf("rewritten path does not route: %q %v", id, ok)
	}

	for _, c := range []struct {
		name, label, path string
		code              int
		store             labelResolver
	}{
		{"root has no service", "5a515e73", "/", http.StatusNotFound, labels},
		{"unknown label", "bbbbbbbb", "/marimo/", http.StatusNotFound, labels},
		{"ambiguous label", "aaaaaaaa", "/marimo/", http.StatusConflict, labels},
		{"no store", "5a515e73", "/marimo/", http.StatusServiceUnavailable, nil},
	} {
		r := httptest.NewRequest("GET", "http://x"+c.path, nil)
		w := httptest.NewRecorder()
		if rewriteSandboxRequest(w, r, c.label, c.store) {
			t.Errorf("%s: rewrite accepted", c.name)
		} else if w.Code != c.code {
			t.Errorf("%s: code = %d, want %d", c.name, w.Code, c.code)
		}
	}
}

// The API is never reachable through a sandbox host, and a client cannot forge the header.
func TestRouterSandboxHostServesOnlyServices(t *testing.T) {
	var seen *http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r
		w.WriteHeader(http.StatusTeapot)
	}))
	defer upstream.Close()
	cfg := config{sandboxDomain: "scooter.example.com", fallback: mustURL(t, upstream.URL)}
	h := newRouter(context.Background(), cfg, nil, nil, nil, nil, nil, nil, nil)

	// No store: the sandbox host is refused rather than falling through to the API.
	r := httptest.NewRequest("GET", "http://5a515e73.scooter.example.com/conversations", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable || seen != nil {
		t.Fatalf("sandbox host reached the API: code=%d proxied=%v", w.Code, seen != nil)
	}

	// The main host proxies as before, with a forged header removed.
	r = httptest.NewRequest("GET", "http://scooter.example.com/c/abc/marimo/", nil)
	r.Header.Set(SandboxHostHeader, "5a515e73")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if seen == nil {
		t.Fatalf("main host not proxied: %d", w.Code)
	}
	if v := seen.Header.Get(SandboxHostHeader); v != "" {
		t.Errorf("forged %s reached the upstream: %q", SandboxHostHeader, v)
	}
}
