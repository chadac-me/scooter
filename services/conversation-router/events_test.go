package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

// notifyDecision is the pure gate on the LISTEN loop, deciding from a NOTIFY payload alone whether to read and push a row.
func TestNotifyDecision(t *testing.T) {
	t.Run("a valid upsert proceeds", func(t *testing.T) {
		c, ok := notifyDecision(`{"id":"uuid-live","op":"upsert"}`)
		if !ok || c.ID != "uuid-live" || c.deleted() {
			t.Fatalf("want a live upsert, got (%+v,%v)", c, ok)
		}
	})

	t.Run("a delete proceeds, flagged as a removal", func(t *testing.T) {
		c, ok := notifyDecision(`{"id":"uuid-gone","op":"delete","owner":"alice"}`)
		if !ok {
			t.Fatal("a delete must reach the fan-out so the sidebar drops the row")
		}
		if !c.deleted() || c.ID != "uuid-gone" {
			t.Fatalf("want a removal of uuid-gone, got %+v", c)
		}
		if c.Owner == nil || *c.Owner != "alice" {
			t.Fatalf("the payload's owner is the only copy a removal can be filtered by, got %v", c.Owner)
		}
	})

	t.Run("an unowned conversation's owner stays nil rather than empty", func(t *testing.T) {
		// "" is a real caller identity to visible(), so a missing owner must not decay into it.
		c, ok := notifyDecision(`{"id":"uuid-free","op":"delete","owner":null}`)
		if !ok || c.Owner != nil {
			t.Fatalf("want a nil owner, got (%+v,%v)", c, ok)
		}
	})

	t.Run("kind decides whether a change may be throttled", func(t *testing.T) {
		activity, ok := notifyDecision(`{"id":"uuid-busy","op":"upsert","kind":"activity"}`)
		if !ok || !activity.activityOnly() {
			t.Fatalf("want an activity-only change, got (%+v,%v)", activity, ok)
		}
		for _, p := range []string{
			`{"id":"uuid-named","op":"upsert","kind":"meta"}`,
			// A pre-#776 database sends no kind at all; those must not be throttled, since a
			// title edit arriving as a bare upsert has to reach the sidebar at once.
			`{"id":"uuid-named","op":"upsert"}`,
		} {
			c, ok := notifyDecision(p)
			if !ok || c.activityOnly() {
				t.Errorf("payload %q must take the un-throttled path, got (%+v,%v)", p, c, ok)
			}
		}
	})

	t.Run("unparseable / empty-id payloads are dropped", func(t *testing.T) {
		for _, p := range []string{`not json`, `{}`, `{"op":"upsert"}`, `{"op":"delete"}`, ``} {
			if _, ok := notifyDecision(p); ok {
				t.Errorf("payload %q should be dropped", p)
			}
		}
	})
}

// broadcast must reach exactly the subscribers a row is visible to.
func TestSSEHubBroadcastVisibility(t *testing.T) {
	hub := newSSEHub()
	alice := hub.subscribe("alice", "mine")
	bob := hub.subscribe("bob", "mine")
	all := hub.subscribe("carol", "all")

	// A row owned by alice: alice sees it, bob (mine) does not, the all-scope subscriber does.
	hub.broadcast(listRow{ID: "x", Owner: sp("alice")})

	if !received(alice) {
		t.Error("owner (alice) must receive her own conversation's upsert")
	}
	if received(bob) {
		t.Error("bob (scope=mine) must NOT receive alice's conversation")
	}
	if !received(all) {
		t.Error("scope=all must receive every conversation")
	}
}

func TestSSEHubUnsubscribeStopsDelivery(t *testing.T) {
	hub := newSSEHub()
	s := hub.subscribe("", "all") // anonymous/all sees everything
	hub.unsubscribe(s)
	hub.broadcast(listRow{ID: "x", Owner: sp("alice")})
	if received(s) {
		t.Error("an unsubscribed client must receive nothing")
	}
}

// A subscriber whose buffer is full must not block the fan-out; the excess frame is dropped.
func TestSSEHubDropsWhenBufferFull(t *testing.T) {
	hub := newSSEHub()
	s := hub.subscribe("", "all")
	// Fill the buffer past capacity.
	for i := 0; i < subBuffer+5; i++ {
		hub.broadcast(listRow{ID: "x", Owner: sp("alice")})
	}
	if got := len(s.ch); got != subBuffer {
		t.Fatalf("buffer should cap at %d, got %d", subBuffer, got)
	}
}

// The upsert frame must match the UI contract: a `data: {kind:"upsert", conversation:{…}}` line carrying the list-row fields verbatim.
func TestSSEHubUpsertFrameShape(t *testing.T) {
	hub := newSSEHub()
	s := hub.subscribe("", "all")
	hub.broadcast(listRow{ID: "c9", Title: "Nine", Status: "running", Owner: sp("alice")})

	msg := <-s.ch
	if got := string(msg[:6]); got != "data: " {
		t.Fatalf("frame must start with the SSE data envelope, got %q", got)
	}
	// Strip "data: " and the trailing blank line.
	body := msg[6 : len(msg)-2]
	var frame struct {
		Kind         string  `json:"kind"`
		Conversation listRow `json:"conversation"`
	}
	if err := json.Unmarshal(body, &frame); err != nil {
		t.Fatalf("frame not valid JSON: %v (%q)", err, string(body))
	}
	if frame.Kind != "upsert" || frame.Conversation.ID != "c9" || frame.Conversation.Title != "Nine" {
		t.Fatalf("unexpected upsert frame: %+v", frame)
	}
}

// received reports whether a subscriber got a frame, without blocking if it did not.
func received(s *sseSub) bool {
	select {
	case <-s.ch:
		return true
	default:
		return false
	}
}

// A removal must obey the same visibility rule as an upsert, using the owner from the payload.
func TestSSEHubBroadcastRemoveVisibility(t *testing.T) {
	hub := newSSEHub()
	alice := hub.subscribe("alice", "mine")
	bob := hub.subscribe("bob", "mine")
	all := hub.subscribe("carol", "all")

	hub.broadcastRemove("x", sp("alice"))

	if !received(alice) {
		t.Error("owner (alice) must learn her own conversation is gone")
	}
	if received(bob) {
		t.Error("bob (scope=mine) must NOT learn an id he could never see")
	}
	if !received(all) {
		t.Error("scope=all must receive every removal")
	}
}

// The remove frame must match the UI contract: `data: {kind:"remove", id:"…"}`, with no row attached.
func TestSSEHubRemoveFrameShape(t *testing.T) {
	hub := newSSEHub()
	s := hub.subscribe("", "all")
	hub.broadcastRemove("c9", sp("alice"))

	msg := <-s.ch
	if got := string(msg[:6]); got != "data: " {
		t.Fatalf("frame must start with the SSE data envelope, got %q", got)
	}
	body := msg[6 : len(msg)-2]
	var frame struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(body, &frame); err != nil {
		t.Fatalf("frame not valid JSON: %v (%q)", err, string(body))
	}
	if frame.Kind != "remove" || frame.ID != "c9" {
		t.Fatalf("unexpected remove frame: %+v", frame)
	}
	// A removal names only the id; the row is already gone.
	if bytes.Contains(body, []byte(`"conversation"`)) {
		t.Errorf("a remove frame must carry no conversation row: %s", body)
	}
}

// An unowned conversation's removal reaches a named caller only under scope=all, exactly as its upsert would.
func TestSSEHubBroadcastRemoveUnowned(t *testing.T) {
	hub := newSSEHub()
	mine := hub.subscribe("alice", "mine")
	all := hub.subscribe("alice", "all")

	hub.broadcastRemove("x", nil)

	if received(mine) {
		t.Error("scope=mine must not receive an unowned conversation's removal")
	}
	if !received(all) {
		t.Error("scope=all must receive an unowned conversation's removal")
	}
}
