package main

import (
	"net/http"
	"strings"
)

// Caller identity, read off the request the ingress already authenticated. It must agree
// with services/agent-host/src/auth/identity.ts: a disagreement makes every caller look
// anonymous, and `visible()` then shows every user every conversation.
type identityConfig struct {
	// "header" (a proxy sets userHeader) or "alb-oidc" (AWS ALB with OIDC).
	mode string
	// header mode: the request header carrying the authenticated user id.
	userHeader string
	// alb-oidc: the header carrying the OIDC subject.
	albIdentityHeader string
	// alb-oidc: the header carrying ALB's signed claims JWT.
	albDataHeader string
}

func identityConfigFromEnv() identityConfig {
	return identityConfig{
		mode:              strings.ToLower(env("AUTH_MODE", "header")),
		userHeader:        env("AUTH_USER_HEADER", "x-auth-user"),
		albIdentityHeader: env("AUTH_ALB_IDENTITY_HEADER", "x-amzn-oidc-identity"),
		albDataHeader:     env("AUTH_ALB_DATA_HEADER", "x-amzn-oidc-data"),
	}
}

// identityHeader is the header this mode reads the user id from.
func (c identityConfig) identityHeader() string {
	if c.mode == "alb-oidc" {
		return c.albIdentityHeader
	}
	return c.userHeader
}

func (c identityConfig) owner(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get(c.identityHeader()))
}

// ownerFrom resolves the caller for spec.owner and the list scope, empty meaning anonymous; it is trusted only because the ingress sets it and strips client copies.
func ownerFrom(r *http.Request) string {
	return identityConfigFromEnv().owner(r)
}
