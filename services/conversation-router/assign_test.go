package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// memStore mimics the row's CAS, to test the Assigner alone.
type memStore struct {
	mu      sync.Mutex
	rows    map[string]Assignment
	short   map[string]string
	claims  atomic.Int32 // successful claims
	tries   atomic.Int32 // claim attempts
	lookups atomic.Int32
	delay   time.Duration
}

func newMemStore(ids ...string) *memStore {
	s := &memStore{rows: map[string]Assignment{}, short: map[string]string{}}
	for _, id := range ids {
		s.rows[id] = Assignment{ConvID: id}
	}
	return s
}

func (s *memStore) Lookup(_ context.Context, id string) (Assignment, bool, error) {
	s.lookups.Add(1)
	time.Sleep(s.delay)
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.short[id]; ok {
		id = c
	}
	a, ok := s.rows[id]
	return a, ok, nil
}

func (s *memStore) Claim(_ context.Context, id string, seen int64, cands []string) (Assignment, bool, error) {
	s.tries.Add(1)
	time.Sleep(s.delay)
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.rows[id]
	if a.Gen != seen {
		return a, false, nil
	}
	a = Assignment{ConvID: id, Pod: cands[0], Gen: seen + 1}
	s.rows[id] = a
	s.claims.Add(1)
	return a, true, nil
}

func (s *memStore) suspend(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.rows[id]
	a.Suspended = true
	s.rows[id] = a
}

func (s *memStore) set(id, pod string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := s.rows[id]
	s.rows[id] = Assignment{ConvID: id, Pod: pod, Gen: a.Gen + 1}
}

type fakePods struct {
	mu    sync.Mutex
	ips   map[string]string
	order []string
}

func pods(kv ...string) *fakePods {
	p := &fakePods{ips: map[string]string{}}
	for i := 0; i+1 < len(kv); i += 2 {
		p.ips[kv[i]] = kv[i+1]
		p.order = append(p.order, kv[i])
	}
	return p
}

func (p *fakePods) IP(n string) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	ip, ok := p.ips[n]
	return ip, ok
}

func (p *fakePods) Ready() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []string
	for _, n := range p.order {
		if _, ok := p.ips[n]; ok {
			out = append(out, n)
		}
	}
	return out
}

func (p *fakePods) kill(n string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.ips, n)
}

func liveAssigner(s AssignStore, p PodSet) *Assigner {
	a := NewAssigner(s, p)
	a.SetLive(true)
	return a
}

func TestConcurrentFirstHitsClaimOnce(t *testing.T) {
	s := newMemStore("c1")
	s.delay = 2 * time.Millisecond
	a := liveAssigner(s, pods("pod-a", "10.0.0.1", "pod-b", "10.0.0.2"))
	var wg sync.WaitGroup
	ips := make(chan string, 64)
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ip, _, found, err := a.Resolve(context.Background(), "c1")
			if err != nil || !found {
				t.Errorf("Resolve: found=%v err=%v", found, err)
			}
			ips <- ip
		}()
	}
	wg.Wait()
	close(ips)
	seen := map[string]bool{}
	for ip := range ips {
		seen[ip] = true
	}
	if len(seen) != 1 {
		t.Fatalf("one conversation routed to %d pods: %v", len(seen), seen)
	}
	// One router never races itself on one conversation.
	if n := s.tries.Load(); n != 1 {
		t.Fatalf("claim attempts = %d, want 1", n)
	}
}

func TestTwoRoutersAgree(t *testing.T) {
	s := newMemStore("c1")
	s.delay = 2 * time.Millisecond
	// Opposite preferences: alone, each would pick differently.
	r1 := liveAssigner(s, pods("pod-a", "10.0.0.1", "pod-b", "10.0.0.2"))
	r2 := liveAssigner(s, pods("pod-b", "10.0.0.2", "pod-a", "10.0.0.1"))
	var wg sync.WaitGroup
	got := make([]string, 2)
	for i, r := range []*Assigner{r1, r2} {
		wg.Add(1)
		go func(i int, r *Assigner) {
			defer wg.Done()
			got[i], _, _, _ = r.Resolve(context.Background(), "c1")
		}(i, r)
	}
	wg.Wait()
	if got[0] != got[1] {
		t.Fatalf("routers disagree: %q vs %q", got[0], got[1])
	}
	if n := s.claims.Load(); n != 1 {
		t.Fatalf("claims = %d, want 1", n)
	}
}

func TestCachedAssignmentSkipsTheStore(t *testing.T) {
	s := newMemStore("c1")
	a := liveAssigner(s, pods("pod-a", "10.0.0.1"))
	for i := 0; i < 5; i++ {
		if ip, _, _, _ := a.Resolve(context.Background(), "c1"); ip != "10.0.0.1" {
			t.Fatalf("ip = %q", ip)
		}
	}
	if n := s.lookups.Load(); n != 1 {
		t.Fatalf("lookups = %d, want 1", n)
	}
}

func TestDeadPodIsReclaimed(t *testing.T) {
	s := newMemStore("c1")
	p := pods("pod-a", "10.0.0.1", "pod-b", "10.0.0.2")
	a := liveAssigner(s, p)
	if ip, _, _, _ := a.Resolve(context.Background(), "c1"); ip != "10.0.0.1" {
		t.Fatalf("first ip = %q", ip)
	}
	p.kill("pod-a")
	ip, _, _, err := a.Resolve(context.Background(), "c1")
	if err != nil || ip != "10.0.0.2" {
		t.Fatalf("after pod-a died: ip=%q err=%v", ip, err)
	}
	if g := s.rows["c1"].Gen; g != 2 {
		t.Fatalf("generation = %d, want 2", g)
	}
}

func TestInvalidateRereadsTheRow(t *testing.T) {
	s := newMemStore("c1")
	a := liveAssigner(s, pods("pod-a", "10.0.0.1", "pod-b", "10.0.0.2"))
	_, _, _, _ = a.Resolve(context.Background(), "c1")
	s.set("c1", "pod-b") // another assigner moved it
	a.Invalidate("c1")
	if ip, _, _, _ := a.Resolve(context.Background(), "c1"); ip != "10.0.0.2" {
		t.Fatalf("ip = %q, want the moved pod", ip)
	}
}

func TestNotLiveNeverTrustsTheCache(t *testing.T) {
	s := newMemStore("c1")
	a := NewAssigner(s, pods("pod-a", "10.0.0.1", "pod-b", "10.0.0.2"))
	_, _, _, _ = a.Resolve(context.Background(), "c1")
	s.set("c1", "pod-b")
	if ip, _, _, _ := a.Resolve(context.Background(), "c1"); ip != "10.0.0.2" {
		t.Fatalf("ip = %q: a stale entry was served without invalidations", ip)
	}
}

func TestUnknownConversationIsNotClaimed(t *testing.T) {
	s := newMemStore()
	a := liveAssigner(s, pods("pod-a", "10.0.0.1"))
	_, _, found, err := a.Resolve(context.Background(), "nope")
	if found || err != nil || s.claims.Load() != 0 {
		t.Fatalf("found=%v err=%v claims=%d", found, err, s.claims.Load())
	}
}

func TestNoReadyPods(t *testing.T) {
	a := liveAssigner(newMemStore("c1"), pods())
	if _, _, _, err := a.Resolve(context.Background(), "c1"); !errors.Is(err, ErrNoPods) {
		t.Fatalf("err = %v, want ErrNoPods", err)
	}
}

func TestShortIDResolvesToItsConversation(t *testing.T) {
	s := newMemStore("thread-uuid")
	s.short["abc123"] = "thread-uuid"
	a := liveAssigner(s, pods("pod-a", "10.0.0.1"))
	ip, conv, _, _ := a.Resolve(context.Background(), "abc123")
	if ip != "10.0.0.1" || conv != "thread-uuid" {
		t.Fatalf("got (%q,%q)", ip, conv)
	}
	a.Invalidate("thread-uuid")
	if _, ok := a.cached("abc123"); ok {
		t.Fatal("invalidating the conversation must drop its alias")
	}
}

func TestRacingClaimsAgreeOnOneWinner(t *testing.T) {
	s := newMemStore("c1")
	s.delay = 2 * time.Millisecond
	// Two routers whose least-loaded pick differs, so a split claim would show as two IPs.
	r1 := liveAssigner(s, pods("pod-a", "10.0.0.1", "pod-b", "10.0.0.2"))
	r2 := liveAssigner(s, pods("pod-b", "10.0.0.2", "pod-a", "10.0.0.1"))
	var mu sync.Mutex
	ips := map[string]bool{}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(r *Assigner) {
			defer wg.Done()
			ip, _, _, err := r.Resolve(context.Background(), "c1")
			if err != nil {
				t.Errorf("resolve: %v", err)
				return
			}
			mu.Lock()
			ips[ip] = true
			mu.Unlock()
		}([]*Assigner{r1, r2}[i%2])
	}
	wg.Wait()
	if len(ips) != 1 {
		t.Fatalf("racing claims routed to %d pods, want 1: %v", len(ips), ips)
	}
}

func TestSuspendedConversationIsReclaimedInPlace(t *testing.T) {
	s := newMemStore("c1")
	s.set("c1", "pod-b")
	s.suspend("c1")
	a := liveAssigner(s, pods("pod-a", "10.0.0.1", "pod-b", "10.0.0.2"))
	ip, _, _, err := a.Resolve(context.Background(), "c1")
	if err != nil || ip != "10.0.0.2" {
		t.Fatalf("ip=%q err=%v, want the revive on its own pod-b", ip, err)
	}
	if r := s.rows["c1"]; r.Suspended || r.Gen != 2 {
		t.Fatalf("row = %+v, want claimed (gen 2, not suspended)", r)
	}
}

func TestSuspendAfterCachingForcesAClaim(t *testing.T) {
	s := newMemStore("c1")
	a := liveAssigner(s, pods("pod-a", "10.0.0.1"))
	_, _, _, _ = a.Resolve(context.Background(), "c1")
	s.suspend("c1")
	a.Invalidate("c1") // the phase trigger
	before := s.claims.Load()
	_, _, _, _ = a.Resolve(context.Background(), "c1")
	if s.claims.Load() != before+1 {
		t.Fatal("a suspended conversation was routed without a claim")
	}
}
