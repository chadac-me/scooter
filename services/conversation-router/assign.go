// Conversation -> host pod, claimed on first route.
package main

import (
	"context"
	"errors"
	"hash/fnv"
	"sync"
	"sync/atomic"
)

// Assignment is a host pod at a fence generation.
type Assignment struct {
	ConvID string
	Pod    string
	Gen    int64
	// Suspended rows are claimed first, or revives get detached.
	Suspended bool
}

// AssignStore reads and claims assignments on the conversations row.
type AssignStore interface {
	// Lookup resolves a thread id or sandbox short-id.
	Lookup(ctx context.Context, id string) (a Assignment, found bool, err error)
	// Claim assigns if still at seenGen; mine if this won.
	Claim(ctx context.Context, convID string, seenGen int64, candidates []string) (Assignment, bool, error)
}

// ErrNoPods means no agent-host pod is ready.
var ErrNoPods = errors.New("no ready agent-host pod")

const lockStripes = 256

// Assigner resolves a conversation's pod, claiming one if needed.
type Assigner struct {
	store AssignStore
	pods  PodSet
	// OnClaim mirrors a won claim onto the CR status.
	OnClaim func(ctx context.Context, as Assignment, ip string)

	// Striped: one conversation's resolves are serialized.
	stripes [lockStripes]sync.Mutex

	// The cache is trusted only while invalidations are flowing.
	live atomic.Bool
	// Bumped per invalidation; a lookup racing one is not cached.
	epoch atomic.Uint64

	mu      sync.RWMutex
	byConv  map[string]Assignment
	aliases map[string]string // requested id (e.g. short-id) -> conversation id
}

func NewAssigner(store AssignStore, pods PodSet) *Assigner {
	return &Assigner{store: store, pods: pods, byConv: map[string]Assignment{}, aliases: map[string]string{}}
}

func (a *Assigner) stripe(id string) *sync.Mutex {
	h := fnv.New32a()
	_, _ = h.Write([]byte(id))
	return &a.stripes[h.Sum32()%lockStripes]
}

func (a *Assigner) cached(id string) (Assignment, bool) {
	if !a.live.Load() {
		return Assignment{}, false
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	conv := id
	if c, ok := a.aliases[id]; ok {
		conv = c
	}
	as, ok := a.byConv[conv]
	return as, ok
}

func (a *Assigner) remember(id string, as Assignment, seen uint64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.epoch.Load() != seen {
		return
	}
	a.byConv[as.ConvID] = as
	if id != as.ConvID {
		a.aliases[id] = as.ConvID
	}
}

// Resolve returns id's pod IP, claiming if unassigned or gone.
func (a *Assigner) Resolve(ctx context.Context, id string) (ip, convID string, found bool, err error) {
	l := a.stripe(id)
	l.Lock()
	defer l.Unlock()

	if as, ok := a.cached(id); ok && !as.Suspended {
		if ip, ok := a.pods.IP(as.Pod); ok {
			return ip, as.ConvID, true, nil
		}
	}
	seen := a.epoch.Load()
	as, found, err := a.store.Lookup(ctx, id)
	if err != nil || !found {
		return "", "", found, err
	}
	ip, live := a.pods.IP(as.Pod)
	if live && !as.Suspended {
		a.remember(id, as, seen)
		return ip, as.ConvID, true, nil
	}
	candidates := a.pods.Ready()
	if live {
		candidates = []string{as.Pod} // revive in place
	}
	if len(candidates) == 0 {
		return "", as.ConvID, true, ErrNoPods
	}
	won, mine, err := a.store.Claim(ctx, as.ConvID, as.Gen, candidates)
	if err != nil {
		return "", as.ConvID, true, err
	}
	a.remember(id, won, seen)
	ip, ok := a.pods.IP(won.Pod)
	if !ok {
		return "", as.ConvID, true, ErrNoPods
	}
	if a.OnClaim != nil && mine {
		a.OnClaim(ctx, won, ip)
	}
	return ip, won.ConvID, true, nil
}

// Assigned reports whether id has a live host.
func (a *Assigner) Assigned(ctx context.Context, id string) bool {
	if as, ok := a.cached(id); ok && !as.Suspended {
		if _, ok := a.pods.IP(as.Pod); ok {
			return true
		}
	}
	as, found, err := a.store.Lookup(ctx, id)
	if err != nil || !found || as.Suspended {
		return false
	}
	_, ok := a.pods.IP(as.Pod)
	return ok
}

// Invalidate drops a conversation whose row assignment changed.
func (a *Assigner) Invalidate(convID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.epoch.Add(1)
	delete(a.byConv, convID)
	for alias, c := range a.aliases {
		if c == convID {
			delete(a.aliases, alias)
		}
	}
}

// SetLive marks whether invalidations flow, dropping the cache.
func (a *Assigner) SetLive(live bool) {
	a.Flush()
	a.live.Store(live)
}

// Flush drops everything, for when invalidations may have been missed.
func (a *Assigner) Flush() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.epoch.Add(1)
	a.byConv = map[string]Assignment{}
	a.aliases = map[string]string{}
}
