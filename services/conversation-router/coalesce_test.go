package main

import (
	"sync"
	"testing"
	"time"
)

// fakeClock stands in for time.AfterFunc so a window's expiry is a test step rather than a sleep.
type fakeClock struct {
	mu      sync.Mutex
	pending map[string][]func() // keyed by the id the callback is for, in arm order
	order   []string
}

func newFakeClock() *fakeClock { return &fakeClock{pending: map[string][]func(){}} }

// after records the callback under the id the coalescer armed it for; the key comes from
// `order`, which the test pushes before each arming call it expects.
func (f *fakeClock) after(_ time.Duration, cb func()) timerHandle {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := "default"
	if n := len(f.order); n > 0 {
		key = f.order[n-1]
	}
	f.pending[key] = append(f.pending[key], cb)
	return fakeTimer{}
}

// fire runs every callback armed since the last fire, which is how a test closes open windows.
func (f *fakeClock) fire(key string) {
	f.mu.Lock()
	cbs := f.pending[key]
	f.pending[key] = nil
	f.mu.Unlock()
	for _, cb := range cbs {
		cb()
	}
}

func (f *fakeClock) armed(key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.pending[key])
}

type fakeTimer struct{}

func (fakeTimer) Stop() bool { return true }

// recorder counts pushes per conversation.
type recorder struct {
	mu sync.Mutex
	n  map[string]int
}

func newRecorder() *recorder { return &recorder{n: map[string]int{}} }

func (r *recorder) push(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.n[id]++
}

func (r *recorder) count(id string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.n[id]
}

// The leading edge is the whole point: a conversation that has been quiet must not wait out a
// window before its activity reaches the sidebar.
func TestCoalescerPushesTheFirstChangeImmediately(t *testing.T) {
	rec, clock := newRecorder(), newFakeClock()
	clock.order = append(clock.order, "a")
	c := newCoalescer(time.Second, rec.push, clock.after)

	c.submit("a")

	if got := rec.count("a"); got != 1 {
		t.Fatalf("first change must push at once, pushed %d times", got)
	}
	if clock.armed("a") != 1 {
		t.Fatal("the push that opened the window owes a timer, or the trailing change is lost")
	}
}

// A burst inside one window must cost exactly one extra push, not one per change.
func TestCoalescerCollapsesABurstIntoOneTrailingPush(t *testing.T) {
	rec, clock := newRecorder(), newFakeClock()
	clock.order = append(clock.order, "a")
	c := newCoalescer(time.Second, rec.push, clock.after)

	c.submit("a") // leading edge
	for range 20 {
		c.submit("a")
	}
	if got := rec.count("a"); got != 1 {
		t.Fatalf("changes inside an open window must not push, pushed %d times", got)
	}

	clock.fire("a") // window expires dirty
	if got := rec.count("a"); got != 2 {
		t.Fatalf("a dirty window owes exactly one trailing push, total pushes %d", got)
	}
}

// After a quiet window the next change starts a fresh burst, or a conversation that goes idle
// and then active again would be delayed by a window it never filled.
func TestCoalescerReopensAfterAQuietWindow(t *testing.T) {
	rec, clock := newRecorder(), newFakeClock()
	clock.order = append(clock.order, "a")
	c := newCoalescer(time.Second, rec.push, clock.after)

	c.submit("a")
	clock.fire("a") // expires clean: no trailing push, window closed
	if got := rec.count("a"); got != 1 {
		t.Fatalf("a clean window must not push, total pushes %d", got)
	}

	c.submit("a")
	if got := rec.count("a"); got != 2 {
		t.Fatalf("a change after a closed window is a fresh leading edge, total pushes %d", got)
	}
}

// A trailing push for a row that has since been deleted would re-add it to every sidebar that
// just dropped it, so a removal has to close the window.
func TestCoalescerForgetDropsThePendingPush(t *testing.T) {
	rec, clock := newRecorder(), newFakeClock()
	clock.order = append(clock.order, "a")
	c := newCoalescer(time.Second, rec.push, clock.after)

	c.submit("a")
	c.submit("a") // window is now dirty
	c.forget("a")
	clock.fire("a")

	if got := rec.count("a"); got != 1 {
		t.Fatalf("a forgotten window must not push, total pushes %d", got)
	}
}

// Windows are per conversation: one busy conversation must not throttle another.
func TestCoalescerWindowsAreIndependentPerConversation(t *testing.T) {
	rec, clock := newRecorder(), newFakeClock()
	c := newCoalescer(time.Second, rec.push, clock.after)

	clock.order = append(clock.order, "a")
	c.submit("a")
	c.submit("a")
	clock.order = append(clock.order, "b")
	c.submit("b")

	if rec.count("a") != 1 || rec.count("b") != 1 {
		t.Fatalf("each conversation gets its own leading edge, got a=%d b=%d", rec.count("a"), rec.count("b"))
	}
	clock.fire("b")
	if rec.count("b") != 1 {
		t.Fatalf("b's window was clean and owes no trailing push, got %d", rec.count("b"))
	}
	if rec.count("a") != 1 {
		t.Fatalf("firing b's window must not push a, got %d", rec.count("a"))
	}
}

// stop must leave nothing armed, so a listener shutdown cannot push into a closed hub.
func TestCoalescerStopClosesEveryWindow(t *testing.T) {
	rec, clock := newRecorder(), newFakeClock()
	c := newCoalescer(time.Second, rec.push, clock.after)

	clock.order = append(clock.order, "a")
	c.submit("a")
	c.submit("a")
	clock.order = append(clock.order, "b")
	c.submit("b")
	c.submit("b")

	c.stop()
	clock.fire("a")
	clock.fire("b")

	if rec.count("a") != 1 || rec.count("b") != 1 {
		t.Fatalf("stop must drop every trailing push, got a=%d b=%d", rec.count("a"), rec.count("b"))
	}
}

// The default window is the real one; a zero would make the throttle a no-op.
func TestActivityWindowIsNonZero(t *testing.T) {
	if activityWindow <= 0 {
		t.Fatalf("activityWindow must be positive, got %v", activityWindow)
	}
}
