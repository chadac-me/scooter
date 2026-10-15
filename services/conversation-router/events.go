// The conversation-list push stream, GET /conversations/events, served from Postgres
// LISTEN/NOTIFY. A single dedicated connection listens on 'conversations_changed'; each
// notification names one conversation id, whose row the loop re-reads and fans out to the
// subscribers entitled to see it, so the push and the GET /conversations snapshot can never
// disagree. The UI contract is an initial `snapshot` then `upsert` and `remove` frames. A
// removal carries the owner in the NOTIFY payload, because its row is gone before the re-read
// and that owner is the only thing the visibility filter could use. The payload's `kind`
// separates activity-only bumps, which coalesce.go throttles per conversation, from meta
// changes, which must not be delayed behind them.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// listenBackoff paces reconnects after the LISTEN connection drops or fails to open.
const listenBackoff = 2 * time.Second

// conversationsChannel is the agent_host NOTIFY channel the conversation rows arrive on.
const conversationsChannel = "conversations_changed"

// sseHeartbeat keeps the SSE connection alive between upserts with a comment frame the UI parser ignores.
const sseHeartbeat = 25 * time.Second

// subBuffer bounds how many upserts a slow subscriber may queue before frames are dropped for it rather than blocking every other subscriber.
const subBuffer = 64

// sseSub is one connected /conversations/events client: its visibility scope and a buffered channel of pre-serialized frames.
type sseSub struct {
	ch          chan []byte
	callerOwner string
	scope       string
}

// sseHub is the set of live subscribers.
type sseHub struct {
	mu   sync.RWMutex
	subs map[*sseSub]struct{}
}

func newSSEHub() *sseHub {
	return &sseHub{subs: map[*sseSub]struct{}{}}
}

func (h *sseHub) subscribe(callerOwner, scope string) *sseSub {
	s := &sseSub{ch: make(chan []byte, subBuffer), callerOwner: callerOwner, scope: scope}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

func (h *sseHub) unsubscribe(s *sseSub) {
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
}

// broadcast serializes the upsert once and delivers it to every subscriber the row is visible to, skipping rather than blocking on a full buffer.
func (h *sseHub) broadcast(row listRow) {
	frame, err := json.Marshal(struct {
		Kind         string  `json:"kind"`
		Conversation listRow `json:"conversation"`
	}{Kind: "upsert", Conversation: row})
	if err != nil {
		return
	}
	h.fanOut(row.Owner, sseData(frame))
}

// broadcastRemove tells the subscribers a conversation was visible to that it is gone, so the sidebar drops it without waiting for the poll.
func (h *sseHub) broadcastRemove(id string, owner *string) {
	frame, err := json.Marshal(struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}{Kind: "remove", ID: id})
	if err != nil {
		return
	}
	h.fanOut(owner, sseData(frame))
}

// fanOut delivers one pre-serialized frame to every subscriber the owner is visible to, skipping rather than blocking on a full buffer.
func (h *sseHub) fanOut(owner *string, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for s := range h.subs {
		if !visible(owner, s.callerOwner, s.scope) {
			continue
		}
		select {
		case s.ch <- msg:
		default: // buffer full; the poll reconciles this subscriber
		}
	}
}

// runConversationListener owns the dedicated LISTEN connection, re-reading and fanning out each notified row, reconnecting after any drop and returning when ctx is cancelled.
func runConversationListener(ctx context.Context, store *Store, links *LinkStore, hub *sseHub) {
	if store == nil {
		return
	}
	log := logger("events-listen")
	// Built once, outside the reconnect loop: a window open when the LISTEN connection drops
	// still owes its trailing push, and its emit must outlive the per-notification context.
	coal := newCoalescer(activityWindow, func(id string) {
		pushUpsert(ctx, id, store, links, hub, log)
	}, nil)
	defer coal.stop()
	listenLoop(ctx, log, conversationsChannel, store.NewListenConn, func(payload string) {
		handleNotification(ctx, payload, store, links, hub, log, coal)
	})
}

// change is one parsed NOTIFY payload: which conversation changed, whether it was removed, and the owner it was visible to.
type change struct {
	ID string `json:"id"`
	Op string `json:"op"`
	// Kind is "activity" when only last_activity_at moved and "meta" otherwise; an empty
	// Kind is a pre-#776 payload, which must take the un-throttled path.
	Kind string `json:"kind"`
	// Owner is the only copy of a deleted row's owner, since the row is gone before the re-read.
	Owner *string `json:"owner"`
}

// deleted reports whether this change removed the conversation.
func (c change) deleted() bool { return c.Op == "delete" }

// activityOnly reports whether this change may be throttled; it mirrors the trigger's `kind` test.
func (c change) activityOnly() bool { return c.Kind == "activity" }

// notifyDecision parses a NOTIFY payload ({id, op, kind, owner}), dropping unparseable payloads and those naming no conversation.
func notifyDecision(payload string) (change, bool) {
	var c change
	if err := json.Unmarshal([]byte(payload), &c); err != nil || c.ID == "" {
		return change{}, false
	}
	return c, true
}

// handleNotification turns one NOTIFY payload into an upsert broadcast by re-reading the row and its links, or into a removal when the row is gone.
func handleNotification(ctx context.Context, payload string, store *Store, links *LinkStore, hub *sseHub, log *slog.Logger, coal *coalescer) {
	c, proceed := notifyDecision(payload)
	if !proceed {
		return
	}
	id := c.ID
	if c.deleted() {
		// Before the removal, so a window's trailing push cannot re-add the row behind it.
		if coal != nil {
			coal.forget(id)
		}
		hub.broadcastRemove(id, c.Owner)
		return
	}
	if coal != nil && c.activityOnly() {
		coal.submit(id)
		return
	}
	pushUpsert(ctx, id, store, links, hub, log)
}

// pushUpsert re-reads a conversation and its links and fans the row out, dropping the push rather than emitting a row the snapshot would disagree with.
func pushUpsert(ctx context.Context, id string, store *Store, links *LinkStore, hub *sseHub, log *slog.Logger) {
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	m, err := store.ConversationByID(rctx, id)
	if err != nil {
		log.Warn("row re-read failed on notify; dropping upsert", convAttr(id), errAttr(err))
		return
	}
	if m == nil {
		return // raced with a delete
	}
	var ls []Link
	if links != nil {
		got, err := links.LinksForConversation(rctx, id)
		if err != nil {
			// The UI takes an upsert's links as authoritative, so a bare row here would clear
			// the sidebar's link icons. Drop the frame instead. Why: PR #779.
			log.Warn("link re-read failed on notify; dropping upsert", convAttr(id), errAttr(err))
			return
		}
		ls = got
	}
	hub.broadcast(makeListRow(*m, ls, time.Now().UnixMilli()))
}

// serveConversationEvents streams an initial snapshot then live upserts, subscribing before the snapshot read so an upsert arriving during it is buffered rather than lost.
func serveConversationEvents(w http.ResponseWriter, r *http.Request, store *Store, links *LinkStore, hub *sseHub) {
	log := logger("events")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	callerOwner, scope := ownerFrom(r), listScope(r)

	// Subscribe first so the buffer holds any upsert racing the snapshot.
	sub := hub.subscribe(callerOwner, scope)
	defer hub.unsubscribe(sub)

	if snap := snapshotFrame(r.Context(), store, links, callerOwner, scope, log); snap != nil {
		if _, err := w.Write(snap); err != nil {
			return
		}
		flusher.Flush()
	}

	ticker := time.NewTicker(sseHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-sub.ch:
			if _, err := w.Write(msg); err != nil {
				return // client hung up
			}
			flusher.Flush()
		case <-ticker.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// snapshotFrame builds the initial `snapshot` SSE frame, an empty list on a store read error and nil only on a marshalling failure.
func snapshotFrame(ctx context.Context, store *Store, links *LinkStore, callerOwner, scope string, log *slog.Logger) []byte {
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var metas []ConversationRow
	if got, err := store.Conversations(rctx); err != nil {
		log.Warn("snapshot read failed; sending empty snapshot", errAttr(err))
	} else {
		metas = got
	}
	linksByConv := map[string][]Link{}
	if links != nil {
		if lm, err := links.LinksByConversation(rctx); err != nil {
			log.Warn("snapshot link read failed; bare rows", errAttr(err))
		} else {
			linksByConv = lm
		}
	}
	rows := assembleList(metas, linksByConv, time.Now().UnixMilli(), callerOwner, scope)
	frame, err := json.Marshal(struct {
		Kind          string    `json:"kind"`
		Conversations []listRow `json:"conversations"`
	}{Kind: "snapshot", Conversations: rows})
	if err != nil {
		log.Warn("snapshot marshal failed", errAttr(err))
		return nil
	}
	return sseData(frame)
}

// sseData wraps a JSON frame in the SSE `data:` envelope.
func sseData(frame []byte) []byte {
	out := make([]byte, 0, len(frame)+8)
	out = append(out, "data: "...)
	out = append(out, frame...)
	out = append(out, '\n', '\n')
	return out
}
