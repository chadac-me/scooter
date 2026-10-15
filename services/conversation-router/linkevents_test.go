package main

import "testing"

// linkNotifyDecision is the pure gate on the link LISTEN loop: the payload names the
// conversation to re-read, and anything else must be dropped rather than re-reading "".
func TestLinkNotifyDecision(t *testing.T) {
	t.Run("a payload naming a conversation proceeds", func(t *testing.T) {
		id, ok := linkNotifyDecision(`{"conversationId":"conv-1"}`)
		if !ok || id != "conv-1" {
			t.Fatalf("want conv-1, got (%q,%v)", id, ok)
		}
	})

	t.Run("unparseable / unnamed payloads are dropped", func(t *testing.T) {
		for _, p := range []string{`not json`, `{}`, `{"conversationId":""}`, `{"conversationId":null}`, ``} {
			if id, ok := linkNotifyDecision(p); ok {
				t.Errorf("%q must be dropped, got %q", p, id)
			}
		}
	})
}
