// Package svcauth verifies projected ServiceAccount tokens into principals.
package svcauth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"k8s.io/client-go/rest"
)

// User-assertion headers; honored only from an asserter SA.
const (
	UserHeader   = "X-Scooter-User"
	EmailHeader  = "X-Scooter-User-Email"
	CallerHeader = "X-Scooter-Caller"
)

// ReviewFunc returns the username a bearer token authenticates as.
type ReviewFunc func(ctx context.Context, token string) (username string, authenticated bool, err error)

// ReviewTimeout bounds one apiserver round-trip.
const ReviewTimeout = 5 * time.Second

// Minimal TokenReview types; avoids depending on k8s.io/api.
type tokenReviewSpec struct {
	Token     string   `json:"token"`
	Audiences []string `json:"audiences,omitempty"`
}

type tokenReviewBody struct {
	APIVersion string          `json:"apiVersion"`
	Kind       string          `json:"kind"`
	Spec       tokenReviewSpec `json:"spec"`
}

type tokenReviewResult struct {
	Status struct {
		Authenticated bool `json:"authenticated"`
		User          struct {
			Username string `json:"username"`
		} `json:"user"`
		Error string `json:"error"`
	} `json:"status"`
}

// NewTokenReviewer pins reviews to comma-separated audiences, or the apiserver default.
func NewTokenReviewer(cfg *rest.Config, audience string) (ReviewFunc, error) {
	client, err := rest.HTTPClientFor(cfg)
	if err != nil {
		return nil, err
	}
	url := strings.TrimSuffix(cfg.Host, "/") + "/apis/authentication.k8s.io/v1/tokenreviews"
	var auds []string
	for _, a := range strings.Split(audience, ",") {
		if a = strings.TrimSpace(a); a != "" {
			auds = append(auds, a)
		}
	}
	return func(ctx context.Context, token string) (string, bool, error) {
		body, err := json.Marshal(tokenReviewBody{
			APIVersion: "authentication.k8s.io/v1",
			Kind:       "TokenReview",
			Spec:       tokenReviewSpec{Token: token, Audiences: auds},
		})
		if err != nil {
			return "", false, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return "", false, err
		}
		req.Header.Set("content-type", "application/json")
		req.Header.Set("accept", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return "", false, err
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if err != nil {
			return "", false, err
		}
		if resp.StatusCode >= 300 {
			// 403 means missing RBAC, not a spoof.
			return "", false, fmt.Errorf("tokenreview returned %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
		}
		var out tokenReviewResult
		if err := json.Unmarshal(raw, &out); err != nil {
			return "", false, err
		}
		if out.Status.Error != "" && !out.Status.Authenticated {
			return "", false, nil // a rejected token
		}
		return out.Status.User.Username, out.Status.Authenticated, nil
	}, nil
}

// CacheTTL caps how long a revoked SA stays accepted.
const CacheTTL = time.Minute

const cacheMax = 4096

type verdict struct {
	username string
	ok       bool
	until    time.Time
}

// Verifier caches verdicts, never errors, so blips don't pin rejections.
type Verifier struct {
	review ReviewFunc
	// Now is the clock; tests replace it.
	Now func() time.Time

	mu    sync.Mutex
	cache map[string]verdict
}

// NewVerifier wraps review in the cache.
func NewVerifier(review ReviewFunc) *Verifier {
	return &Verifier{review: review, Now: time.Now, cache: map[string]verdict{}}
}

// Verify returns the username `token` authenticates as.
func (v *Verifier) Verify(ctx context.Context, token string) (string, bool, error) {
	sum := sha256.Sum256([]byte(token))
	key := hex.EncodeToString(sum[:])
	now := v.Now()
	v.mu.Lock()
	if c, ok := v.cache[key]; ok && now.Before(c.until) {
		v.mu.Unlock()
		return c.username, c.ok, nil
	}
	v.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, ReviewTimeout)
	defer cancel()
	username, ok, err := v.review(ctx, token)
	if err != nil {
		return "", false, err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if len(v.cache) >= cacheMax { // drop expired, or all if none expired
		for k, c := range v.cache {
			if !now.Before(c.until) {
				delete(v.cache, k)
			}
		}
		if len(v.cache) >= cacheMax {
			v.cache = map[string]verdict{}
		}
	}
	v.cache[key] = verdict{username: username, ok: ok, until: now.Add(CacheTTL)}
	return username, ok, nil
}

// BearerToken extracts an `Authorization: Bearer <token>` value, "" if absent.
func BearerToken(r *http.Request) string {
	v := r.Header.Get("authorization")
	if len(v) < len("bearer ") || !strings.EqualFold(v[:len("bearer ")], "bearer ") {
		return ""
	}
	return strings.TrimSpace(v[len("bearer "):])
}

// Kind is the class of a resolved principal.
type Kind string

const (
	KindService Kind = "service"
	KindSandbox Kind = "sandbox"
)

// Principal: User/Email are set only when an asserter vouched.
type Principal struct {
	Kind           Kind
	ServiceAccount string
	SandboxID      string // KindSandbox only: the `<id>` of `sandbox-<id>`
	User           string
	Email          string
}

// Policy is a receiver's allowlist.
type Policy struct {
	// Services are the SA usernames admitted as services.
	Services map[string]bool
	// Asserters may set X-Scooter-User and are admitted as services.
	Asserters map[string]bool
	// SandboxNamespace admits `sandbox-<id>` SAs in that namespace; "" admits none.
	SandboxNamespace string
}

// Errors Resolve returns; Status maps them to an HTTP status.
var (
	ErrNoToken         = errors.New("bearer token required")
	ErrUnauthenticated = errors.New("token not authenticated")
	ErrNotAllowed      = errors.New("caller not allowed")
)

// Status maps a Resolve error to 401, 403 or 503.
func Status(err error) int {
	switch {
	case errors.Is(err, ErrNoToken), errors.Is(err, ErrUnauthenticated):
		return http.StatusUnauthorized
	case errors.Is(err, ErrNotAllowed):
		return http.StatusForbidden
	default:
		return http.StatusServiceUnavailable
	}
}

var sandboxSA = regexp.MustCompile(`^sandbox-([a-z0-9][a-z0-9-]*)$`)

// SandboxID extracts `<id>` from `sandbox-<id>`, only within namespace.
func SandboxID(username, namespace string) (string, bool) {
	if namespace == "" {
		return "", false
	}
	prefix := "system:serviceaccount:" + namespace + ":"
	if !strings.HasPrefix(username, prefix) {
		return "", false
	}
	m := sandboxSA.FindStringSubmatch(strings.TrimPrefix(username, prefix))
	if m == nil {
		return "", false
	}
	return m[1], true
}

// Resolve ignores identity headers from non-asserters; forwarders must strip.
func (v *Verifier) Resolve(ctx context.Context, r *http.Request, p Policy) (Principal, error) {
	token := BearerToken(r)
	if token == "" {
		return Principal{}, ErrNoToken
	}
	username, ok, err := v.Verify(ctx, token)
	if err != nil {
		return Principal{}, fmt.Errorf("token review: %w", err)
	}
	if !ok {
		return Principal{}, ErrUnauthenticated
	}
	if p.Asserters[username] {
		return Principal{
			Kind:           KindService,
			ServiceAccount: username,
			User:           strings.TrimSpace(r.Header.Get(UserHeader)),
			Email:          strings.TrimSpace(r.Header.Get(EmailHeader)),
		}, nil
	}
	if p.Services[username] {
		return Principal{Kind: KindService, ServiceAccount: username}, nil
	}
	if id, ok := SandboxID(username, p.SandboxNamespace); ok {
		return Principal{Kind: KindSandbox, ServiceAccount: username, SandboxID: id}, nil
	}
	return Principal{ServiceAccount: username}, fmt.Errorf("%w: %s", ErrNotAllowed, username)
}

// ParseAllowlist parses a comma-separated list of SA usernames.
func ParseAllowlist(csv string) map[string]bool {
	out := map[string]bool{}
	for _, s := range strings.Split(csv, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out[s] = true
		}
	}
	return out
}

// TokenSource re-reads the token file; the kubelet rotates it.
type TokenSource struct {
	Path    string
	Refresh time.Duration // 0 = one minute
	Now     func() time.Time

	mu    sync.Mutex
	token string
	read  time.Time
}

// Token returns "" without error when no token is mounted.
func (s *TokenSource) Token() (string, error) {
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	refresh := s.Refresh
	if refresh == 0 {
		refresh = time.Minute
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token != "" && now().Sub(s.read) < refresh {
		return s.token, nil
	}
	raw, err := os.ReadFile(s.Path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read service token %s: %w", s.Path, err)
	}
	s.token, s.read = strings.TrimSpace(string(raw)), now()
	return s.token, nil
}

// Authorize adds the bearer token and, if set, user headers.
func (s *TokenSource) Authorize(req *http.Request, user, email string) error {
	token, err := s.Token()
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if user != "" {
		req.Header.Set(UserHeader, user)
		if email != "" {
			req.Header.Set(EmailHeader, email)
		}
	}
	return nil
}
