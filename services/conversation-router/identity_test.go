package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func reqWith(headers map[string]string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/conversations", nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestOwnerFromReadsTheDefaultHeader(t *testing.T) {
	if got := ownerFrom(reqWith(map[string]string{"x-auth-user": "alice"})); got != "alice" {
		t.Fatalf("want alice, got %q", got)
	}
}

func TestOwnerFromTrimsAndTreatsBlankAsAnonymous(t *testing.T) {
	if got := ownerFrom(reqWith(map[string]string{"x-auth-user": "  alice  "})); got != "alice" {
		t.Fatalf("want alice, got %q", got)
	}
	if got := ownerFrom(reqWith(map[string]string{"x-auth-user": "   "})); got != "" {
		t.Fatalf("blank must be anonymous, got %q", got)
	}
	if got := ownerFrom(reqWith(nil)); got != "" {
		t.Fatalf("absent must be anonymous, got %q", got)
	}
}

func TestOwnerFromHonorsARenamedHeader(t *testing.T) {
	t.Setenv("AUTH_USER_HEADER", "x-forwarded-user")
	if got := ownerFrom(reqWith(map[string]string{"x-forwarded-user": "alice"})); got != "alice" {
		t.Fatalf("want alice from the configured header, got %q", got)
	}
	// The ingress only strips the configured header, so honoring the default too would let a client spoof identity.
	if got := ownerFrom(reqWith(map[string]string{"x-auth-user": "attacker"})); got != "" {
		t.Fatalf("the default header must be ignored when renamed, got %q", got)
	}
}

// In alb-oidc mode the sub arrives in x-amzn-oidc-identity, not x-auth-user.
func TestOwnerFromSupportsAlbOidc(t *testing.T) {
	t.Setenv("AUTH_MODE", "alb-oidc")
	if got := ownerFrom(reqWith(map[string]string{"x-amzn-oidc-identity": "cognito-sub-abc"})); got != "cognito-sub-abc" {
		t.Fatalf("want the ALB sub, got %q", got)
	}
	if got := ownerFrom(reqWith(map[string]string{"x-auth-user": "alice"})); got != "" {
		t.Fatalf("alb-oidc must not read x-auth-user, got %q", got)
	}
}

func TestOwnerFromAlbIdentityHeaderIsOverridable(t *testing.T) {
	t.Setenv("AUTH_MODE", "ALB-OIDC") // case-insensitive, as the agent-host treats it
	t.Setenv("AUTH_ALB_IDENTITY_HEADER", "x-custom-sub")
	if got := ownerFrom(reqWith(map[string]string{"x-custom-sub": "sub-1"})); got != "sub-1" {
		t.Fatalf("want sub-1, got %q", got)
	}
}
