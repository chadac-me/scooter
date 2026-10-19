// The create-time `conversations` row, one definition shared by the cluster path
// (rowCreator) and the kube-less path (devCreator) so the two stacks cannot disagree
// about what a new conversation looks like.
package main

// insertConversationSQL is that one definition: thread_id == id by construction, ON CONFLICT DO NOTHING keeps a retry idempotent, the INSERT fires the conversations_changed trigger that pushes the row to the sidebar, and sandbox_ref is set only for a subagent.
// A subagent starts on its parent's pod, which appends immediately.
const insertConversationSQL = `
	INSERT INTO conversations
	  (id, thread_id, title, created_at, last_activity_at, model, owner, parent_id, sandbox_ref,
	   host_pod, host_generation)
	SELECT $1, $1, $2, $3, $3, $4, $5, $6, $7,
	       p.host_pod, CASE WHEN p.host_pod IS NULL THEN 0 ELSE 1 END
	  FROM (SELECT 1) one
	  LEFT JOIN conversations p ON p.id = $6
	ON CONFLICT (id) DO NOTHING`

// conversationRow is the row projection; args() alone fixes order.
type conversationRow struct {
	ID    string
	Title string
	// Fills both created_at and last_activity_at ($3 twice).
	Now        int64
	Model      *string
	Owner      *string
	ParentID   *string
	SandboxRef *string
}

// conversationRowOf is that projection, pure and so testable.
func conversationRowOf(c NewConversation, now int64) conversationRow {
	return conversationRow{
		ID:         c.Name,
		Title:      c.Title,
		Now:        now,
		Model:      specString(c.Spec, "model"),
		Owner:      specString(c.Spec, "owner"),
		ParentID:   specString(c.Spec, "parentId"),
		SandboxRef: specString(c.Spec, "sandboxRef"),
	}
}

// args binds the row to insertConversationSQL's placeholders, in order.
func (r conversationRow) args() []any {
	return []any{r.ID, r.Title, r.Now, r.Model, r.Owner, r.ParentID, r.SandboxRef}
}

// specString reads a string spec value, treating "" and a non-string as absent.
func specString(spec map[string]interface{}, k string) *string {
	if v, ok := spec[k].(string); ok && v != "" {
		return &v
	}
	return nil
}
