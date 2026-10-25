// Long-lived proxied requests (event streams, terminal and other web-service WebSockets) are
// authorized when they open, so a conversation going private must also end the ones its
// non-owners already hold. Every proxied request for a conversation is tracked here with its
// caller; the NOTIFY listener calls revoke on the shared -> private edge. Cancelling a request's
// context makes httputil.ReverseProxy close both sides, an upgraded connection included.
package main

import (
	"context"
	"net/http"
	"sync"
)

type liveReq struct {
	caller string
	cancel context.CancelFunc
}

type liveRegistry struct {
	mu   sync.Mutex
	byID map[string]map[*liveReq]struct{}
}

func newLiveRegistry() *liveRegistry {
	return &liveRegistry{byID: map[string]map[*liveReq]struct{}{}}
}

// track registers r for convID and returns it with a cancellable context plus the release the
// caller must defer. A nil registry or an empty convID tracks nothing.
func (l *liveRegistry) track(r *http.Request, convID, caller string) (*http.Request, func()) {
	if l == nil || convID == "" {
		return r, func() {}
	}
	ctx, cancel := context.WithCancel(r.Context())
	e := &liveReq{caller: caller, cancel: cancel}
	l.mu.Lock()
	set := l.byID[convID]
	if set == nil {
		set = map[*liveReq]struct{}{}
		l.byID[convID] = set
	}
	set[e] = struct{}{}
	l.mu.Unlock()
	return r.WithContext(ctx), func() {
		cancel()
		l.mu.Lock()
		delete(set, e)
		if len(set) == 0 && l.byID[convID] != nil && len(l.byID[convID]) == 0 {
			delete(l.byID, convID)
		}
		l.mu.Unlock()
	}
}

// revoke ends every tracked request for convID whose caller may not access it as private.
// It returns how many it ended.
func (l *liveRegistry) revoke(convID string, owner *string) int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for e := range l.byID[convID] {
		if !canAccess(owner, VisibilityPrivate, e.caller) {
			e.cancel()
			n++
		}
	}
	return n
}

// liveConns is the process-wide registry: both listeners track into it, and the NOTIFY listener
// revokes from it.
var liveConns = newLiveRegistry()
