// Live link changes on the conversation-list stream: resource_links lives in the webhooks
// database, so no agent_host notification fires when a link is attached, and until now the
// sidebar's link icons only appeared on the next GET /conversations poll. Why: PR #779.
package main

import (
	"context"
	"encoding/json"
)

// resourceLinksChannel is the webhooks NOTIFY channel link changes arrive on.
const resourceLinksChannel = "resource_links_changed"

// linkChange is one parsed resource_links_changed payload; the link's own columns are absent
// by design, since the answer is always to re-read the conversation's whole link set.
type linkChange struct {
	ConversationID string `json:"conversationId"`
}

// linkNotifyDecision parses a resource_links_changed payload, dropping unparseable ones and those naming no conversation.
func linkNotifyDecision(payload string) (string, bool) {
	var c linkChange
	if err := json.Unmarshal([]byte(payload), &c); err != nil || c.ConversationID == "" {
		return "", false
	}
	return c.ConversationID, true
}

// runLinkListener pushes the affected conversation's row whenever its links change, and returns when ctx is cancelled or no link store is configured.
func runLinkListener(ctx context.Context, store *Store, links *LinkStore, hub *sseHub) {
	if store == nil || links == nil || links.connConfig == nil {
		return
	}
	log := logger("links-listen")
	// One push per conversation per window: attaching a resource writes several rows (a PR and
	// its issue, a Slack thread and its channel), and each would otherwise re-read and fan out.
	coal := newCoalescer(activityWindow, func(id string) {
		pushUpsert(ctx, id, store, links, hub, log)
	}, nil)
	defer coal.stop()
	listenLoop(ctx, log, resourceLinksChannel, links.NewListenConn, func(payload string) {
		id, ok := linkNotifyDecision(payload)
		if !ok {
			return
		}
		// A link change cannot remove the conversation, so there is no forget() path here: the
		// row either still exists and is re-read, or pushUpsert finds it gone and stays quiet.
		coal.submit(id)
	})
}
