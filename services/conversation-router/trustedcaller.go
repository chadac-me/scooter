package main

// Trusted-caller verification for the in-cluster services that create conversations on
// behalf of a human (webhooks, scheduler). They never come through the ingress that injects
// the identity header, so they send `owner` in the body, which the router honors only for
// a caller whose ServiceAccount token verifies via TokenReview against an allowlist. It
// fails closed and is never fatal: anything not trusted means the body `owner` is ignored.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"k8s.io/client-go/rest"
)

// TrustedCaller reports whether a request proves it is a trusted in-cluster caller allowed to set `owner`; nil means verification is disabled.
type TrustedCaller func(ctx context.Context, r *http.Request) bool

// tokenReviewTimeout bounds the apiserver round-trip a body-owner create costs.
const tokenReviewTimeout = 5 * time.Second

// reviewTokenFunc verifies one bearer token, returning the username it authenticates as.
type reviewTokenFunc func(ctx context.Context, token string) (username string, authenticated bool, err error)

// --- the TokenReview wire types ---------------------------------------------------
// Hand-rolled so the module graph does not need k8s.io/api for four fields.

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

// newTokenReviewer posts TokenReviews to the apiserver with the router's own credentials; `audience` must match what the caller's token was projected for.
func newTokenReviewer(cfg *rest.Config, audience string) (reviewTokenFunc, error) {
	client, err := rest.HTTPClientFor(cfg)
	if err != nil {
		return nil, err
	}
	url := strings.TrimSuffix(cfg.Host, "/") + "/apis/authentication.k8s.io/v1/tokenreviews"
	return func(ctx context.Context, token string) (string, bool, error) {
		body, err := json.Marshal(tokenReviewBody{
			APIVersion: "authentication.k8s.io/v1",
			Kind:       "TokenReview",
			Spec:       tokenReviewSpec{Token: token, Audiences: audiences(audience)},
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
			// A 403 here is a missing RBAC grant, not a spoof, so surface the status.
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

func audiences(a string) []string {
	if a == "" {
		return nil
	}
	return []string{a}
}

// bearerToken extracts an `Authorization: Bearer <token>` value, "" if absent.
func bearerToken(r *http.Request) string {
	v := r.Header.Get("authorization")
	if len(v) < len("bearer ") || !strings.EqualFold(v[:len("bearer ")], "bearer ") {
		return ""
	}
	return strings.TrimSpace(v[len("bearer "):])
}

// trustedServiceAccounts parses the comma-separated allowlist of SA usernames from the env var the agent-host also reads.
func trustedServiceAccounts() map[string]bool {
	out := map[string]bool{}
	for _, s := range strings.Split(env("WEBHOOKS_SERVICE_ACCOUNT", ""), ",") {
		if s = strings.TrimSpace(s); s != "" {
			out[s] = true
		}
	}
	return out
}

// newTrustedCaller wraps a reviewer in the allowlist check, returning nil when there is no allowlist or no reviewer.
func newTrustedCaller(review reviewTokenFunc, allowed map[string]bool) TrustedCaller {
	if len(allowed) == 0 || review == nil {
		return nil
	}
	log := logger("trusted-caller")
	return func(ctx context.Context, r *http.Request) bool {
		token := bearerToken(r)
		if token == "" {
			return false
		}
		ctx, cancel := context.WithTimeout(ctx, tokenReviewTimeout)
		defer cancel()
		username, ok, err := review(ctx, token)
		if err != nil {
			// Fail closed but loudly, since a missing RBAC grant is indistinguishable from a spoof here.
			log.Warn("TokenReview failed, body owner not honored", errAttr(err))
			return false
		}
		if !ok || !allowed[username] {
			log.Warn("caller may not set an owner, body owner ignored",
				slog.String("username", username),
				slog.Bool("authenticated", ok))
			return false
		}
		return true
	}
}
