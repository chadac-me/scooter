package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// startPG runs a throwaway Postgres with the agent_host migrations replayed.
func startPG(t *testing.T) *pgxpool.Pool {
	t.Helper()
	for _, bin := range []string{"initdb", "pg_ctl"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Fatalf("%s not on PATH: these tests need a real Postgres", bin)
		}
	}
	dir := t.TempDir()
	data := filepath.Join(dir, "data")
	// Unix socket paths cap at 107 bytes; test-named dirs overflow it.
	sock, err := os.MkdirTemp("", "pg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sock) })
	run := func(name string, args ...string) {
		if out, err := exec.Command(name, args...).CombinedOutput(); err != nil {
			t.Fatalf("%s %v: %v\n%s", name, args, err, out)
		}
	}
	run("initdb", "-D", data, "-U", "postgres", "--auth=trust", "--no-sync")
	run("pg_ctl", "-D", data, "-w", "-l", filepath.Join(dir, "log"),
		"-o", "-k "+sock+" -c listen_addresses= -c fsync=off", "start")
	t.Cleanup(func() { _ = exec.Command("pg_ctl", "-D", data, "-m", "immediate", "stop").Run() })

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, "host="+sock+" user=postgres dbname=postgres")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	migs := os.Getenv("AGENT_HOST_MIGRATIONS")
	if migs == "" {
		migs = "../../lib/sql/agent_host/migrations"
	}
	files, _ := filepath.Glob(filepath.Join(migs, "*.sql"))
	if len(files) == 0 {
		t.Fatalf("no migrations under %s", migs)
	}
	sort.Strings(files)
	for _, f := range files {
		sql, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("%s: %v", filepath.Base(f), err)
		}
	}
	return pool
}

func insertConv(t *testing.T, pool *pgxpool.Pool, id, parent, sandboxRef string) {
	t.Helper()
	nc := NewConversation{Name: id, Spec: map[string]interface{}{}}
	if parent != "" {
		nc.Spec["parentId"] = parent
	}
	if sandboxRef != "" {
		nc.Spec["sandboxRef"] = sandboxRef
	}
	if _, err := pool.Exec(context.Background(), insertConversationSQL,
		conversationRowOf(nc, time.Now().UnixMilli()).args()...); err != nil {
		t.Fatal(err)
	}
}

func setHost(t *testing.T, pool *pgxpool.Pool, id, pod string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`UPDATE conversations SET host_pod = $2, host_generation = host_generation + 1 WHERE id = $1`, id, pod); err != nil {
		t.Fatal(err)
	}
}

func TestPgClaimTakesTheLeastLoadedPod(t *testing.T) {
	pool := startPG(t)
	s := &PgAssignStore{pool: pool}
	ctx := context.Background()
	insertConv(t, pool, "busy", "", "")
	setHost(t, pool, "busy", "pod-a")
	insertConv(t, pool, "c1", "", "")

	a, won, err := s.Claim(ctx, "c1", 0, []string{"pod-a", "pod-b"})
	if err != nil || !won || a.Pod != "pod-b" || a.Gen != 1 {
		t.Fatalf("claim = %+v, %v; want pod-b at gen 1", a, err)
	}
	// A stale-generation claim changes nothing, reporting the winner.
	b, won, err := s.Claim(ctx, "c1", 0, []string{"pod-a"})
	if err != nil || won || b.Pod != "pod-b" || b.Gen != 1 {
		t.Fatalf("stale claim = %+v, %v; want the existing pod-b", b, err)
	}
}

func TestPgConcurrentClaimsAssignOnce(t *testing.T) {
	pool := startPG(t)
	s := &PgAssignStore{pool: pool}
	insertConv(t, pool, "c1", "", "")
	orders := [][]string{{"pod-a", "pod-b"}, {"pod-b", "pod-a"}}
	var wg sync.WaitGroup
	got := make([]Assignment, 16)
	for i := range got {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Equal load: only the CAS makes them agree.
			a, _, err := s.Claim(context.Background(), "c1", 0, orders[i%2])
			if err != nil {
				t.Error(err)
			}
			got[i] = a
		}(i)
	}
	wg.Wait()
	for _, a := range got {
		if a.Pod != got[0].Pod || a.Gen != 1 {
			t.Fatalf("claims disagree: %+v", got)
		}
	}
}

func TestPgSubagentFollowsItsParent(t *testing.T) {
	pool := startPG(t)
	s := &PgAssignStore{pool: pool}
	ctx := context.Background()
	insertConv(t, pool, "parent", "", "conv-abc")
	setHost(t, pool, "parent", "pod-b")

	insertConv(t, pool, "child", "parent", "conv-abc")
	a, found, err := s.Lookup(ctx, "child")
	if err != nil || !found || a.Pod != "pod-b" || a.Gen != 1 {
		t.Fatalf("child row = %+v found=%v err=%v; want the parent's pod at gen 1", a, found, err)
	}
	// The short-id names the top-level conversation.
	p, _, _ := s.Lookup(ctx, "abc")
	if p.ConvID != "parent" {
		t.Fatalf("short-id resolved to %q, want parent", p.ConvID)
	}
	// Reclaimed after a pod death, the child follows its parent.
	setHost(t, pool, "parent", "pod-c")
	c, _, err := s.Claim(ctx, "child", 1, []string{"pod-a", "pod-c"})
	if err != nil || c.Pod != "pod-c" {
		t.Fatalf("child claim = %+v, %v; want the parent's pod-c", c, err)
	}
}

func TestPgAssignmentChangeInvalidatesTheRouterCache(t *testing.T) {
	pool := startPG(t)
	insertConv(t, pool, "c1", "", "")
	setHost(t, pool, "c1", "pod-a")

	a := NewAssigner(&PgAssignStore{pool: pool}, pods("pod-a", "10.0.0.1", "pod-b", "10.0.0.2"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runAssignListener(ctx, pool.Config().ConnConfig, a)
	deadline := time.Now().Add(10 * time.Second)
	for !a.live.Load() {
		if time.Now().After(deadline) {
			t.Fatal("listener never connected")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if ip, _, _, _ := a.Resolve(ctx, "c1"); ip != "10.0.0.1" {
		t.Fatalf("ip = %q", ip)
	}
	if _, ok := a.cached("c1"); !ok {
		t.Fatal("expected c1 cached")
	}

	// Another assigner moves it; the trigger must reach this router.
	setHost(t, pool, "c1", "pod-b")
	for {
		if ip, _, _, _ := a.Resolve(ctx, "c1"); ip == "10.0.0.2" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("router kept routing to the old pod after the row moved")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestPgSuspendedRowIsClaimedAndResumed(t *testing.T) {
	pool := startPG(t)
	s := &PgAssignStore{pool: pool}
	ctx := context.Background()
	insertConv(t, pool, "c1", "", "")
	setHost(t, pool, "c1", "pod-a")
	if _, err := pool.Exec(ctx, `UPDATE conversations SET phase = 'Suspended' WHERE id = 'c1'`); err != nil {
		t.Fatal(err)
	}
	a, _, _ := s.Lookup(ctx, "c1")
	if !a.Suspended || a.Pod != "pod-a" {
		t.Fatalf("lookup = %+v, want suspended on pod-a", a)
	}
	won, mine, err := s.Claim(ctx, "c1", a.Gen, []string{"pod-a"})
	if err != nil || !mine || won.Pod != "pod-a" || won.Gen != a.Gen+1 {
		t.Fatalf("claim = %+v mine=%v err=%v", won, mine, err)
	}
	after, _, _ := s.Lookup(ctx, "c1")
	if after.Suspended {
		t.Fatal("a claimed revive must leave Suspended, or the controller detaches it")
	}
}

func TestPgSuspendInvalidatesTheRouterCache(t *testing.T) {
	pool := startPG(t)
	insertConv(t, pool, "c1", "", "")
	setHost(t, pool, "c1", "pod-a")
	a := NewAssigner(&PgAssignStore{pool: pool}, pods("pod-a", "10.0.0.1"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runAssignListener(ctx, pool.Config().ConnConfig, a)
	deadline := time.Now().Add(10 * time.Second)
	for !a.live.Load() {
		if time.Now().After(deadline) {
			t.Fatal("listener never connected")
		}
		time.Sleep(10 * time.Millisecond)
	}
	_, _, _, _ = a.Resolve(ctx, "c1")
	if _, err := pool.Exec(ctx, `UPDATE conversations SET phase = 'Suspended' WHERE id = 'c1'`); err != nil {
		t.Fatal(err)
	}
	for {
		if _, ok := a.cached("c1"); !ok {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("suspend never invalidated the cached assignment")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestPgNoTriggerMeansNoCache(t *testing.T) {
	pool := startPG(t)
	if _, err := pool.Exec(context.Background(), `DROP TRIGGER conversation_assignment_upd ON conversations`); err != nil {
		t.Fatal(err)
	}
	insertConv(t, pool, "c1", "", "")
	triggerRecheck = 50 * time.Millisecond
	a := NewAssigner(&PgAssignStore{pool: pool}, pods("pod-a", "10.0.0.1"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runAssignListener(ctx, pool.Config().ConnConfig, a)
	time.Sleep(500 * time.Millisecond)
	if a.live.Load() {
		t.Fatal("cache went live with nothing to invalidate it")
	}
}

// The conversations_changed payload is the ONLY copy of a deleted row's owner — the row is
// gone before the listener can re-read it — so the remove frame's visibility filter lives or
// dies by this trigger. Replays the real migrations, so it also guards the trigger's SQL.
func TestPgNotifyPayloadCarriesOpAndOwner(t *testing.T) {
	pool := startPG(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// waitForDelete drains notifications until the row's delete arrives, since the owner
	// UPDATE notifies first, and returns what the router would parse from it.
	waitForDelete := func(t *testing.T, conn *pgxpool.Conn, id string) change {
		t.Helper()
		for {
			n, err := conn.Conn().WaitForNotification(ctx)
			if err != nil {
				t.Fatalf("%s: no delete notification arrived: %v", id, err)
			}
			c, ok := notifyDecision(n.Payload)
			if !ok {
				t.Fatalf("the router would drop its own trigger's payload: %q", n.Payload)
			}
			if c.ID == id && c.deleted() {
				return c
			}
		}
	}

	listen := func(t *testing.T) *pgxpool.Conn {
		t.Helper()
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(conn.Release)
		if _, err := conn.Exec(ctx, "listen conversations_changed"); err != nil {
			t.Fatal(err)
		}
		return conn
	}

	t.Run("an owned conversation's delete names its owner", func(t *testing.T) {
		insertConv(t, pool, "c-owned", "", "")
		if _, err := pool.Exec(ctx, `UPDATE conversations SET owner = 'alice' WHERE id = 'c-owned'`); err != nil {
			t.Fatal(err)
		}
		conn := listen(t)
		if _, err := pool.Exec(ctx, `DELETE FROM conversations WHERE id = 'c-owned'`); err != nil {
			t.Fatal(err)
		}
		c := waitForDelete(t, conn, "c-owned")
		if c.Owner == nil || *c.Owner != "alice" {
			t.Fatalf("owner = %v, want alice; without it a removal cannot be visibility-filtered", c.Owner)
		}
	})

	t.Run("an unowned conversation's delete reports a nil owner, not an empty one", func(t *testing.T) {
		// "" is a real caller identity to visible(), so the two must stay distinguishable.
		insertConv(t, pool, "c-unowned", "", "")
		conn := listen(t)
		if _, err := pool.Exec(ctx, `DELETE FROM conversations WHERE id = 'c-unowned'`); err != nil {
			t.Fatal(err)
		}
		if c := waitForDelete(t, conn, "c-unowned"); c.Owner != nil {
			t.Fatalf("owner = %v, want nil", c.Owner)
		}
	})

	t.Run("an insert still notifies as an upsert", func(t *testing.T) {
		conn := listen(t)
		insertConv(t, pool, "c-new", "", "")
		for {
			n, err := conn.Conn().WaitForNotification(ctx)
			if err != nil {
				t.Fatalf("no insert notification arrived: %v", err)
			}
			c, ok := notifyDecision(n.Payload)
			if !ok {
				t.Fatalf("the router would drop its own trigger's payload: %q", n.Payload)
			}
			if c.ID != "c-new" {
				continue
			}
			if c.deleted() {
				t.Fatalf("an insert must notify as an upsert, got %+v", c)
			}
			return
		}
	})
}
