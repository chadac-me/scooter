package svcauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"k8s.io/client-go/rest"
)

const (
	ns          = "agent-sandbox"
	webhooks    = "system:serviceaccount:agent-sandbox:agent-webhooks"
	broker      = "system:serviceaccount:agent-sandbox:agent-broker"
	sandboxUser = "system:serviceaccount:agent-sandbox:sandbox-abc123"
)

// fakeReview knows token -> username; "boom" errors; anything else is rejected.
func fakeReview(calls *int, known map[string]string) ReviewFunc {
	return func(_ context.Context, token string) (string, bool, error) {
		*calls++
		if token == "boom" {
			return "", false, errors.New("apiserver unavailable")
		}
		u, ok := known[token]
		return u, ok, nil
	}
}

func req(token string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestVerifierCachesDefiniteVerdictsOnly(t *testing.T) {
	calls := 0
	v := NewVerifier(fakeReview(&calls, map[string]string{"good": broker}))
	now := time.Unix(1000, 0)
	v.Now = func() time.Time { return now }
	ctx := context.Background()

	for range 2 {
		if u, ok, err := v.Verify(ctx, "good"); err != nil || !ok || u != broker {
			t.Fatalf("Verify(good) = %q %v %v", u, ok, err)
		}
		if _, ok, _ := v.Verify(ctx, "forged"); ok {
			t.Fatal("forged token authenticated")
		}
	}
	if calls != 2 {
		t.Fatalf("reviews = %d, want 2 (accepted and rejected verdicts both cached)", calls)
	}
	now = now.Add(CacheTTL + time.Second)
	v.Verify(ctx, "good")
	if calls != 3 {
		t.Fatalf("reviews = %d, want 3 after the TTL", calls)
	}
	v.Verify(ctx, "boom")
	v.Verify(ctx, "boom")
	if calls != 5 {
		t.Fatalf("reviews = %d, want 5 (errors never cached)", calls)
	}
}

func TestResolve(t *testing.T) {
	calls := 0
	v := NewVerifier(fakeReview(&calls, map[string]string{
		"webhooks": webhooks, "broker": broker, "sandbox": sandboxUser,
		"stranger": "system:serviceaccount:other:sandbox-abc123",
	}))
	p := Policy{
		Services:         map[string]bool{broker: true},
		Asserters:        map[string]bool{webhooks: true},
		SandboxNamespace: ns,
	}
	user := map[string]string{UserHeader: "chadac", EmailHeader: "chad@example.com"}
	ctx := context.Background()

	cases := []struct {
		name    string
		r       *http.Request
		want    Principal
		wantErr error
		status  int
	}{
		{"asserter names a user", req("webhooks", user),
			Principal{Kind: KindService, ServiceAccount: webhooks, User: "chadac", Email: "chad@example.com"}, nil, 0},
		{"a non-asserter's user header is ignored", req("broker", user),
			Principal{Kind: KindService, ServiceAccount: broker}, nil, 0},
		{"a sandbox is bound to its id and cannot name a user", req("sandbox", user),
			Principal{Kind: KindSandbox, ServiceAccount: sandboxUser, SandboxID: "abc123"}, nil, 0},
		{"a sandbox SA in another namespace is refused", req("stranger", nil), Principal{}, ErrNotAllowed, 403},
		{"no token", req("", user), Principal{}, ErrNoToken, 401},
		{"forged token", req("forged", nil), Principal{}, ErrUnauthenticated, 401},
		{"review failure", req("boom", nil), Principal{}, nil, 503},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := v.Resolve(ctx, tc.r, p)
			if tc.status != 0 {
				if err == nil || Status(err) != tc.status {
					t.Fatalf("err = %v (status %d), want status %d", err, Status(err), tc.status)
				}
				if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				if got.Kind != "" {
					t.Fatalf("a rejected caller resolved to kind %q", got.Kind)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("Resolve = %+v, %v; want %+v", got, err, tc.want)
			}
		})
	}
}

func TestSandboxIDNeedsANamespace(t *testing.T) {
	if _, ok := SandboxID(sandboxUser, ""); ok {
		t.Fatal("an empty SandboxNamespace must admit no sandbox")
	}
}

func TestTokenSourceRereadsRotatedTokens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	now := time.Unix(1000, 0)
	s := &TokenSource{Path: path, Now: func() time.Time { return now }}

	if tok, err := s.Token(); err != nil || tok != "" {
		t.Fatalf("absent token = %q, %v; want no token and no error", tok, err)
	}
	os.WriteFile(path, []byte("one\n"), 0o600)
	if tok, _ := s.Token(); tok != "one" {
		t.Fatalf("token = %q, want one", tok)
	}
	os.WriteFile(path, []byte("two"), 0o600)
	if tok, _ := s.Token(); tok != "one" {
		t.Fatalf("token = %q, want the cached one", tok)
	}
	now = now.Add(time.Minute)
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if err := s.Authorize(r, "chadac", ""); err != nil {
		t.Fatal(err)
	}
	if r.Header.Get("Authorization") != "Bearer two" || r.Header.Get(UserHeader) != "chadac" || r.Header.Get(EmailHeader) != "" {
		t.Fatalf("headers = %v", r.Header)
	}
}

func TestTokenReviewerSendsEveryAudience(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body tokenReviewBody
		_ = json.NewDecoder(r.Body).Decode(&body)
		got = body.Spec.Audiences
		_, _ = w.Write([]byte(`{"status":{"authenticated":true,"user":{"username":"` + webhooks + `"}}}`))
	}))
	defer srv.Close()
	review, err := NewTokenReviewer(&rest.Config{Host: srv.URL}, "agent-host, scooter-router,")
	if err != nil {
		t.Fatal(err)
	}
	user, ok, err := review(context.Background(), "tok")
	if err != nil || !ok || user != webhooks {
		t.Fatalf("review = %q %v %v", user, ok, err)
	}
	if strings.Join(got, ",") != "agent-host,scooter-router" {
		t.Fatalf("audiences = %q", got)
	}
}
