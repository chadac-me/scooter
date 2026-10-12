// The conversation-list push stream, GET /conversations/events, served from Postgres
// LISTEN/NOTIFY. A single dedicated connection listens on 'conversations_changed'; each
// notification names one conversation id, whose row the loop re-reads and fans out to the
// subscribers entitled to see it, so the push and the GET /conversations snapshot can never
// disagree. The UI contract is an initial `snapshot` then `upsert` frames; removals are not
// pushed and are reconciled by the poll.
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
	msg := sseData(frame)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for s := range h.subs {
		if !visible(row.Owner, s.callerOwner, s.scope) {
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
	for ctx.Err() == nil {
		conn, err := store.NewListenConn(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Warn("listen connect failed; retrying",
				slog.Int("retry_in_ms", int(listenBackoff.Milliseconds())), errAttr(err))
			sleep(ctx, listenBackoff)
			continue
		}
		if _, err := conn.Exec(ctx, "listen conversations_changed"); err != nil {
			if ctx.Err() != nil {
				_ = conn.Close(context.Background())
				return
			}
			log.Warn("LISTEN failed; retrying",
				slog.Int("retry_in_ms", int(listenBackoff.Milliseconds())), errAttr(err))
			_ = conn.Close(context.Background())
			sleep(ctx, listenBackoff)
			continue
		}
		log.Info("listening for conversation changes")
		for ctx.Err() == nil {
			n, err := conn.WaitForNotification(ctx)
			if err != nil {
				if ctx.Err() == nil {
					log.Warn("notification wait failed; reconnecting", errAttr(err))
				}
				break
			}
			handleNotification(ctx, n.Payload, store, links, hub, log)
		}
		// Close with a background context, since a Close on a cancelled ctx would skip the teardown.
		_ = conn.Close(context.Background())
		if ctx.Err() == nil {
			sleep(ctx, listenBackoff)
		}
	}
}

// notifyDecision parses a NOTIFY payload ({id, op}) and returns the conversation id to read and whether to proceed, dropping unparseable payloads and op=delete.
func notifyDecision(payload string) (string, bool) {
	var p struct {
		ID string `json:"id"`
		Op string `json:"op"`
	}
	if err := json.Unmarshal([]byte(payload), &p); err != nil || p.ID == "" || p.Op == "delete" {
		return "", false
	}
	return p.ID, true
}

// handleNotification turns one NOTIFY payload into an upsert broadcast by re-reading the row and its links.
func handleNotification(ctx context.Context, payload string, store *Store, links *LinkStore, hub *sseHub, log *slog.Logger) {
	id, proceed := notifyDecision(payload)
	if !proceed {
		return
	}
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
		if got, err := links.LinksForConversation(rctx, id); err != nil {
			log.Warn("link re-read failed on notify; pushing bare row", convAttr(id), errAttr(err))
		} else {
			ls = got
		}
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
