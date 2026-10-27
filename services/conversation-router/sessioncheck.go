package main

// Proves browser sessions via the auth proxy's forwardAuth endpoint.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	sessionCacheTTL = 30 * time.Second
	sessionCacheMax = 4096
	sessionTimeout  = 5 * time.Second
)

var (
	errNoSession      = errors.New("no session cookie")
	errSessionInvalid = errors.New("session not authenticated")
)

type sessionVerdict struct {
	user, email string
	ok          bool
	until       time.Time
}

// sessionChecker caches definite verdicts by cookie hash, never errors.
type sessionChecker struct {
	url      string
	prefixes []string
	client   *http.Client
	now      func() time.Time

	mu    sync.Mutex
	cache map[string]sessionVerdict
}

func newSessionChecker(url string, prefixes []string) *sessionChecker {
	return &sessionChecker{
		url:      url,
		prefixes: prefixes,
		client:   &http.Client{Timeout: sessionTimeout},
		now:      time.Now,
		cache:    map[string]sessionVerdict{},
	}
}

// sessionCookies keeps only the auth proxy's cookies, for stable cache keys.
func sessionCookies(r *http.Request, prefixes []string) string {
	var kept []string
	for _, c := range r.Cookies() {
		for _, p := range prefixes {
			if strings.HasPrefix(c.Name, p) {
				kept = append(kept, c.Name+"="+c.Value)
				break
			}
		}
	}
	return strings.Join(kept, "; ")
}

// check returns the user the session belongs to.
func (s *sessionChecker) check(ctx context.Context, r *http.Request) (user, email string, err error) {
	cookie := sessionCookies(r, s.prefixes)
	if cookie == "" {
		return "", "", errNoSession
	}
	sum := sha256.Sum256([]byte(cookie))
	key := hex.EncodeToString(sum[:])
	now := s.now()
	s.mu.Lock()
	if v, ok := s.cache[key]; ok && now.Before(v.until) {
		s.mu.Unlock()
		if !v.ok {
			return "", "", errSessionInvalid
		}
		return v.user, v.email, nil
	}
	s.mu.Unlock()

	v, err := s.ask(ctx, cookie)
	if err != nil {
		return "", "", err
	}
	v.until = now.Add(sessionCacheTTL)
	s.mu.Lock()
	if len(s.cache) >= sessionCacheMax { // drop expired, or all if none expired
		for k, c := range s.cache {
			if !now.Before(c.until) {
				delete(s.cache, k)
			}
		}
		if len(s.cache) >= sessionCacheMax {
			s.cache = map[string]sessionVerdict{}
		}
	}
	s.cache[key] = v
	s.mu.Unlock()
	if !v.ok {
		return "", "", errSessionInvalid
	}
	return v.user, v.email, nil
}

// ask: 2xx names the user, 401/403 rejects, else errors.
func (s *sessionChecker) ask(ctx context.Context, cookie string) (sessionVerdict, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return sessionVerdict{}, err
	}
	req.Header.Set("Cookie", cookie)
	resp, err := s.client.Do(req)
	if err != nil {
		return sessionVerdict{}, fmt.Errorf("session check: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	switch {
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		return sessionVerdict{}, nil
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		user := strings.TrimSpace(resp.Header.Get("X-Auth-Request-User"))
		if user == "" {
			// Uncached: missing set_xauthrequest is misconfiguration, not rejection.
			return sessionVerdict{}, errors.New("session check named no user (set_xauthrequest off?)")
		}
		return sessionVerdict{ok: true, user: user, email: strings.TrimSpace(resp.Header.Get("X-Auth-Request-Email"))}, nil
	default:
		return sessionVerdict{}, fmt.Errorf("session check returned %d", resp.StatusCode)
	}
}
