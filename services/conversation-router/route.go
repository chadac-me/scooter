// The pure routing logic: extract a conversation id from a request and resolve which
// upstream it should go to, with no k8s or network.
package main

import (
	"net/http"
	"net/url"
	"strings"
)

// ConvIDFromPath extracts the conversation id from a request path, ("", false) when it carries none.
//
//	/conversations/<id>                     -> <id>
//	/conversations/<id>/<anything...>       -> <id>
//	/c/<id>/<service>/<rest...>             -> <id>   (the web-service proxy, incl. WS)
func ConvIDFromPath(path string) (string, bool) {
	parts := splitPath(path)
	if len(parts) < 2 {
		return "", false
	}
	switch parts[0] {
	case "conversations", "c":
		// /conversations/events is the list stream, not a conversation whose id is "events".
		if parts[0] == "conversations" && parts[1] == "events" {
			return "", false
		}
		if parts[1] != "" {
			return parts[1], true
		}
	}
	return "", false
}

// IsConversationListRoute reports whether a request is the conversation list or its live events stream, the two routes served from Postgres rather than proxied.
func IsConversationListRoute(method, path string) bool {
	if method != "GET" {
		return false
	}
	parts := splitPath(path)
	if len(parts) == 1 && parts[0] == "conversations" {
		return true // GET /conversations
	}
	if len(parts) == 2 && parts[0] == "conversations" && parts[1] == "events" {
		return true // GET /conversations/events
	}
	return false
}

// IsAguiPost reports whether this is the POST /agui route, whose id lives in the body.
func IsAguiPost(method, path string) bool {
	parts := splitPath(path)
	return method == "POST" && len(parts) == 1 && parts[0] == "agui"
}

// MetadataPatch matches PATCH /conversations/<id>/{starred,title}, returning the field and id.
func MetadataPatch(method, path string) (field, id string, ok bool) {
	if method != http.MethodPatch {
		return "", "", false
	}
	parts := splitPath(path)
	if len(parts) != 3 || parts[0] != "conversations" {
		return "", "", false
	}
	if parts[2] != "starred" && parts[2] != "title" {
		return "", "", false
	}
	return parts[2], parts[1], true
}

// IsNonScoped reports whether a path is routable to any ready pod, such as a health check.
func IsNonScoped(path string) bool {
	parts := splitPath(path)
	if len(parts) == 0 {
		return true
	}
	switch parts[0] {
	case "healthz", "health", "metrics":
		return true
	}
	return false
}

// TargetURL builds the upstream base URL for an owner pod, addressed by its pod IP from the agent-host pod watch.
func TargetURL(hostIP string, port int) *url.URL {
	return &url.URL{
		Scheme: "http",
		Host:   hostIP + ":" + itoa(port),
	}
}

// FallbackURL is the agent-host ClusterIP Service, the upstream for non-scoped, unassigned and stale-IP requests.
func FallbackURL(clusterIPService, namespace string, port int) *url.URL {
	return &url.URL{
		Scheme: "http",
		Host:   clusterIPService + "." + namespace + ".svc.cluster.local:" + itoa(port),
	}
}

func splitPath(path string) []string {
	out := make([]string, 0, 4)
	for _, p := range strings.Split(path, "/") {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// itoa formats a small positive int without strconv.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
