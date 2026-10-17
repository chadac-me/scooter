// Sandbox hosts: each conversation's web services are served from their own origin,
// https://<label>.<sandbox domain>/<service>/, where <label> is a prefix of the
// conversation id. The router resolves the label to the conversation, rewrites the
// request onto the internal /c/<id>/<service>/ shape the agent-host proxy already
// serves, and marks it with SandboxHostHeader so the proxy forwards /<service>/...
// (not /c/<id>/...) to the pod.
//
// A sandbox host serves web services and nothing else: the API, the UI and every
// other route stay on the main host, so a page on one conversation's origin cannot
// reach them same-origin.
package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strings"
)

// SandboxHostHeader carries the sandbox label of a host-routed request to the
// agent-host. The router always removes a client-supplied copy first, so only the
// router can set it.
const SandboxHostHeader = "X-Scooter-Sandbox-Host"

// sandboxLabelRE: a DNS label made of conversation-id characters, at least 8 long,
// not starting or ending with a hyphen.
var sandboxLabelRE = regexp.MustCompile(`^[0-9a-f][0-9a-f-]{6,34}[0-9a-f]$`)

// ErrAmbiguousLabel is returned when a label is a prefix of more than one conversation.
var ErrAmbiguousLabel = errors.New("sandbox label matches more than one conversation")

// SandboxLabel returns the conversation label of host under domain, or ("", false)
// when host is not a sandbox host. domain == "" disables sandbox hosts.
func SandboxLabel(host, domain string) (string, bool) {
	if domain == "" {
		return "", false
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	label, rest, ok := strings.Cut(host, ".")
	if !ok || rest != strings.ToLower(strings.TrimSuffix(domain, ".")) {
		return "", false
	}
	if !sandboxLabelRE.MatchString(label) {
		return "", false
	}
	return label, true
}

// labelResolver maps a sandbox label to its conversation id.
type labelResolver interface {
	ConversationByLabel(ctx context.Context, label string) (id string, found bool, err error)
}

// ConversationByLabel resolves a label to the one top-level conversation whose id
// starts with it. Two matches are refused rather than guessed (ErrAmbiguousLabel).
func (s *Store) ConversationByLabel(ctx context.Context, label string) (string, bool, error) {
	if !sandboxLabelRE.MatchString(label) {
		return "", false, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id FROM conversations
		 WHERE parent_id IS NULL AND starts_with(id, $1)
		 LIMIT 2`, label)
	if err != nil {
		return "", false, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return "", false, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return "", false, err
	}
	switch len(ids) {
	case 0:
		return "", false, nil
	case 1:
		return ids[0], true, nil
	default:
		return "", false, ErrAmbiguousLabel
	}
}

// rewriteSandboxRequest resolves a sandbox-host request and rewrites it in place onto
// /c/<id>/<service>/..., marked with SandboxHostHeader. It writes the error response
// itself and returns false when the request must not be proxied.
func rewriteSandboxRequest(w http.ResponseWriter, r *http.Request, label string, labels labelResolver) bool {
	if labels == nil {
		http.Error(w, "conversation store unavailable", http.StatusServiceUnavailable)
		return false
	}
	// A sandbox origin serves only services: /<service>/... with a service segment.
	if len(splitPath(r.URL.Path)) == 0 {
		http.NotFound(w, r)
		return false
	}
	id, found, err := labels.ConversationByLabel(r.Context(), label)
	switch {
	case errors.Is(err, ErrAmbiguousLabel):
		logger("route").Warn("sandbox label is ambiguous", "label", label)
		http.Error(w, "this sandbox address matches more than one conversation", http.StatusConflict)
		return false
	case err != nil:
		logger("route").Warn("sandbox label lookup failed", "label", label, errAttr(err))
		http.Error(w, "conversation lookup failed", http.StatusServiceUnavailable)
		return false
	case !found:
		http.NotFound(w, r)
		return false
	}
	prefix := "/c/" + id
	r.URL.Path = prefix + r.URL.Path
	if r.URL.RawPath != "" {
		r.URL.RawPath = prefix + r.URL.RawPath
	}
	r.RequestURI = ""
	r.Header.Set(SandboxHostHeader, label)
	return true
}
