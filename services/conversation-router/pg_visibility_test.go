package main

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// insertOwned inserts a conversation through the router's own insert, with an owner and an
// optional requested visibility and parent.
func insertOwned(t *testing.T, pool *pgxpool.Pool, id, owner, visibility, parent string) {
	t.Helper()
	spec := map[string]interface{}{"owner": owner}
	if visibility != "" {
		spec["visibility"] = visibility
	}
	if parent != "" {
		spec["parentId"] = parent
	}
	if _, err := pool.Exec(context.Background(), insertConversationSQL,
		conversationRowOf(NewConversation{Name: id, Spec: spec}, time.Now().UnixMilli()).args()...); err != nil {
		t.Fatal(err)
	}
}

func visibilityOfRow(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	var v string
	if err := pool.QueryRow(context.Background(), `SELECT visibility FROM conversations WHERE id = $1`, id).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestPgVisibility(t *testing.T) {
	pool := startPG(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ws := &WriteStore{pool: pool}

	t.Run("a new conversation is shared unless asked", func(t *testing.T) {
		insertOwned(t, pool, "v-default", "alice", "", "")
		if got := visibilityOfRow(t, pool, "v-default"); got != VisibilityShared {
			t.Fatalf("visibility = %q", got)
		}
	})

	t.Run("a subagent of a private parent is private whatever it asked for", func(t *testing.T) {
		insertOwned(t, pool, "v-root", "alice", VisibilityPrivate, "")
		insertOwned(t, pool, "v-child", "alice", "", "v-root")
		if got := visibilityOfRow(t, pool, "v-child"); got != VisibilityPrivate {
			t.Fatalf("child visibility = %q, want private", got)
		}
	})

	t.Run("private needs an owner, enforced by the schema", func(t *testing.T) {
		_, err := pool.Exec(ctx, insertConversationSQL,
			conversationRowOf(NewConversation{Name: "v-orphan", Spec: map[string]interface{}{"visibility": "private"}}, 1).args()...)
		if err == nil {
			t.Fatal("inserted a private conversation with no owner")
		}
	})

	t.Run("SetVisibility covers the whole subtree and returns the root", func(t *testing.T) {
		insertOwned(t, pool, "t-root", "alice", "", "")
		insertOwned(t, pool, "t-kid", "alice", "", "t-root")
		insertOwned(t, pool, "t-grandkid", "alice", "", "t-kid")
		insertOwned(t, pool, "t-other", "alice", "", "")
		row, err := ws.SetVisibility(ctx, "t-root", VisibilityPrivate)
		if err != nil {
			t.Fatal(err)
		}
		if row == nil || row.ID != "t-root" || row.Visibility != VisibilityPrivate {
			t.Fatalf("returned %+v", row)
		}
		for _, id := range []string{"t-kid", "t-grandkid"} {
			if got := visibilityOfRow(t, pool, id); got != VisibilityPrivate {
				t.Errorf("%s = %q, want private", id, got)
			}
		}
		if got := visibilityOfRow(t, pool, "t-other"); got != VisibilityShared {
			t.Errorf("an unrelated conversation became %q", got)
		}
		if row, err := ws.SetVisibility(ctx, "t-missing", VisibilityPrivate); err != nil || row != nil {
			t.Fatalf("missing row: %+v, %v", row, err)
		}
	})

	t.Run("the trigger marks the shared -> private edge, and only that edge", func(t *testing.T) {
		insertOwned(t, pool, "n-conv", "alice", "", "")
		conn, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Release()
		if _, err := conn.Exec(ctx, "listen conversations_changed"); err != nil {
			t.Fatal(err)
		}
		next := func() change {
			t.Helper()
			for {
				n, err := conn.Conn().WaitForNotification(ctx)
				if err != nil {
					t.Fatalf("no notification: %v", err)
				}
				if c, ok := notifyDecision(n.Payload); ok && c.ID == "n-conv" {
					return c
				}
			}
		}
		if _, err := ws.SetVisibility(ctx, "n-conv", VisibilityPrivate); err != nil {
			t.Fatal(err)
		}
		if c := next(); !c.WentPrivate || c.Visibility != VisibilityPrivate || c.activityOnly() {
			t.Fatalf("going private: %+v", c)
		}
		if _, err := pool.Exec(ctx, `UPDATE conversations SET last_activity_at = last_activity_at + 1 WHERE id = 'n-conv'`); err != nil {
			t.Fatal(err)
		}
		if c := next(); c.WentPrivate || c.Visibility != VisibilityPrivate {
			t.Fatalf("activity on a private row: %+v", c)
		}
		if _, err := ws.SetVisibility(ctx, "n-conv", VisibilityShared); err != nil {
			t.Fatal(err)
		}
		if c := next(); c.WentPrivate || c.Visibility != VisibilityShared || c.activityOnly() {
			t.Fatalf("going shared: %+v", c)
		}
		if _, err := pool.Exec(ctx, `DELETE FROM conversations WHERE id = 'n-conv'`); err != nil {
			t.Fatal(err)
		}
		if c := next(); !c.deleted() || c.Visibility != VisibilityShared {
			t.Fatalf("delete: %+v", c)
		}
	})

	t.Run("the list read carries visibility", func(t *testing.T) {
		insertOwned(t, pool, "l-priv", "alice", VisibilityPrivate, "")
		row, err := (&Store{pool: pool}).ConversationByID(ctx, "l-priv")
		if err != nil || row == nil || row.Visibility != VisibilityPrivate {
			t.Fatalf("%+v, %v", row, err)
		}
	})
}
