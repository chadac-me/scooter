// Conversation visibility: who may see and drive a conversation. Mirrors canAccess in
// services/agent-host/src/session/visibility.ts; test/fixtures/visibility-cases.json pins both.
package main

const (
	VisibilityShared  = "shared"
	VisibilityPrivate = "private"
)

// canAccess reports whether caller may see or act on a conversation. A private one admits its
// owner alone: not an anonymous caller, since private rows always have an owner and a missing
// identity on a multi-user deployment must not read as "everyone".
func canAccess(owner *string, visibility, caller string) bool {
	if visibility != VisibilityPrivate {
		return true
	}
	return caller != "" && owner != nil && *owner == caller
}

// visibilityOf normalizes a stored value, reading "" (a row from before the column) as shared.
func visibilityOf(v string) string {
	if v == VisibilityPrivate {
		return VisibilityPrivate
	}
	return VisibilityShared
}
