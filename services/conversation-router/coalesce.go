// Per-conversation throttling for the conversation-list push stream: bursts of activity-only
// changes collapse into at most one push per window, leading edge first so the first change of
// a burst is never delayed. Meta changes bypass this entirely. Why: PR #776.
package main

import (
	"sync"
	"time"
)

// activityWindow bounds how often one conversation's activity-only change is pushed.
const activityWindow = 2 * time.Second

// timerHandle is the part of *time.Timer the coalescer uses, so a test can drive windows by hand.
type timerHandle interface{ Stop() bool }

// afterFunc schedules f after d, injected so tests need no real clock.
type afterFunc func(d time.Duration, f func()) timerHandle

func realAfterFunc(d time.Duration, f func()) timerHandle { return time.AfterFunc(d, f) }

// openWindow is one conversation's in-flight throttle window.
type openWindow struct {
	timer timerHandle
	// dirty records a change that arrived while the window was open, owing one push on expiry.
	dirty bool
}

// coalescer collapses bursts of activity-only changes per conversation.
type coalescer struct {
	mu    sync.Mutex
	dur   time.Duration
	after afterFunc
	open  map[string]*openWindow
	push  func(id string)
}

func newCoalescer(d time.Duration, push func(id string), after afterFunc) *coalescer {
	if after == nil {
		after = realAfterFunc
	}
	return &coalescer{dur: d, after: after, open: map[string]*openWindow{}, push: push}
}

// submit pushes id at once when no window is open for it, and otherwise folds into the open one.
func (c *coalescer) submit(id string) {
	c.mu.Lock()
	if w, ok := c.open[id]; ok {
		w.dirty = true
		c.mu.Unlock()
		return
	}
	c.open[id] = &openWindow{}
	c.mu.Unlock()
	// Deliberately outside the lock: push does a row re-read, and holding the mutex across it
	// would serialize every conversation's stream behind one query.
	c.push(id)
	c.arm(id)
}

// arm starts the window's timer, which the push that opened it owes.
func (c *coalescer) arm(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	w, ok := c.open[id]
	if !ok {
		return // forget() or stop() closed the window while the push was running
	}
	w.timer = c.after(c.dur, func() { c.expire(id) })
}

// expire closes a quiet window, or pushes once more and reopens it when the window saw a change.
func (c *coalescer) expire(id string) {
	c.mu.Lock()
	w, ok := c.open[id]
	if !ok {
		c.mu.Unlock()
		return
	}
	if !w.dirty {
		// Nothing arrived: close it, so the next change is a fresh burst and pushes immediately.
		delete(c.open, id)
		c.mu.Unlock()
		return
	}
	w.dirty = false
	c.mu.Unlock()
	c.push(id)
	c.arm(id)
}

// forget drops a conversation's window so a removed row cannot be pushed after its removal.
func (c *coalescer) forget(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeLocked(id)
}

// stop cancels every open window.
func (c *coalescer) stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id := range c.open {
		c.closeLocked(id)
	}
}

func (c *coalescer) closeLocked(id string) {
	w, ok := c.open[id]
	if !ok {
		return
	}
	if w.timer != nil {
		w.timer.Stop()
	}
	delete(c.open, id)
}
