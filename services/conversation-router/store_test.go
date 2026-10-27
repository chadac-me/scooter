package main

import (
	"strings"
	"testing"
)

// storeDSNFromEnv must not leak a wrong default or build a DSN when no DB is configured.
func TestStoreDSNFromEnv(t *testing.T) {
	clear := func() {
		for _, k := range []string{
			"AGENT_HOST_DB_DSN", "AGENT_HOST_DB_PASSWORD", "AGENT_HOST_DB_HOST",
			"AGENT_HOST_DB_PORT", "AGENT_HOST_DB_NAME", "AGENT_HOST_DB_USER", "AGENT_HOST_DB_SSLMODE",
		} {
			t.Setenv(k, "")
		}
	}

	t.Run("no password means not configured", func(t *testing.T) {
		clear()
		if dsn := storeDSNFromEnv(); dsn != "" {
			t.Fatalf("want empty DSN when unconfigured, got %q", dsn)
		}
	})

	t.Run("explicit DSN wins", func(t *testing.T) {
		clear()
		t.Setenv("AGENT_HOST_DB_DSN", "postgresql://x/y")
		t.Setenv("AGENT_HOST_DB_PASSWORD", "ignored")
		if dsn := storeDSNFromEnv(); dsn != "postgresql://x/y" {
			t.Fatalf("explicit DSN not honored, got %q", dsn)
		}
	})

	t.Run("assembled from components with reader defaults", func(t *testing.T) {
		clear()
		t.Setenv("AGENT_HOST_DB_PASSWORD", "p@ss/word")
		t.Setenv("AGENT_HOST_DB_HOST", "agent-shared-db.ns.svc")
		dsn := storeDSNFromEnv()
		// The default user is the read-only role, the default db is agent_host, and the password is escaped.
		if !strings.Contains(dsn, "conversation_router:") {
			t.Errorf("expected default read-only user in DSN: %q", dsn)
		}
		if !strings.HasSuffix(dsn, "@agent-shared-db.ns.svc:5432/agent_host") {
			t.Errorf("host/port/db not assembled as expected: %q", dsn)
		}
		if strings.Contains(dsn, "p@ss/word") {
			t.Errorf("password must be URL-escaped, not raw: %q", dsn)
		}
	})

	t.Run("sslmode appended when set", func(t *testing.T) {
		clear()
		t.Setenv("AGENT_HOST_DB_PASSWORD", "pw")
		t.Setenv("AGENT_HOST_DB_SSLMODE", "require")
		if dsn := storeDSNFromEnv(); !strings.HasSuffix(dsn, "?sslmode=require") {
			t.Fatalf("sslmode not appended: %q", dsn)
		}
	})
}

// Every connection the pool opens must carry default_transaction_read_only=on.
func TestBuildPoolConfigIsReadOnly(t *testing.T) {
	cfg, err := buildPoolConfig("postgresql://u:p@h:5432/agent_host")
	if err != nil {
		t.Fatalf("buildPoolConfig: %v", err)
	}
	if got := cfg.ConnConfig.RuntimeParams["default_transaction_read_only"]; got != "on" {
		t.Fatalf("connection not pinned read-only: got %q", got)
	}
	if cfg.MinConns != 0 {
		t.Errorf("want MinConns=0 for an idle-cheap proxy pool, got %d", cfg.MinConns)
	}
}

// awaitingStoreDSNFromEnv swaps only the database name, keeping credentials and options.
func TestAwaitingStoreDSNFromEnv(t *testing.T) {
	t.Setenv("AGENT_HOST_DB_DSN", "postgres://postgres@127.0.0.1:55432/agent_host?sslmode=disable")
	if dsn := awaitingStoreDSNFromEnv(); dsn != "" {
		t.Fatalf("no AWAITING_INPUT_DB_NAME must mean no DSN, got %q", dsn)
	}
	t.Setenv("AWAITING_INPUT_DB_NAME", "contrib_ask_user")
	if dsn, want := awaitingStoreDSNFromEnv(), "postgres://postgres@127.0.0.1:55432/contrib_ask_user?sslmode=disable"; dsn != want {
		t.Fatalf("got %q, want %q", dsn, want)
	}
}
