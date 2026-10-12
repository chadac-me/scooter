// Kube-less dev/e2e mode, reached only when ROUTER_DEV_MODE is set: a single agent-host
// fronts a real Postgres with no apiserver or controller. The seams that differ are routing
// (a single AGENT_HOST_URL) and create (the conversations-row insert alone, with no CR).
// Existence and phase are columns on the row read by one code path in both stacks, and a
// dev-only substitute for either would stop the e2e suite being evidence about production.
package main

import (
	"context"
	"errors"
	"net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// devModeEnabled reports whether to run the kube-less dev/e2e mode.
func devModeEnabled() bool {
	v := os.Getenv("ROUTER_DEV_MODE")
	return v == "1" || v == "true"
}

// agentHostURLFromEnv parses AGENT_HOST_URL, the single absolute upstream every dev-mode request proxies to.
func agentHostURLFromEnv() (*url.URL, error) {
	raw := os.Getenv("AGENT_HOST_URL")
	if raw == "" {
		return nil, errors.New("ROUTER_DEV_MODE needs AGENT_HOST_URL (the single agent-host to proxy to)")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "" || u.Host == "" {
		return nil, errors.New("AGENT_HOST_URL must be absolute, e.g. http://127.0.0.1:8079")
	}
	return u, nil
}

// devCreator is the kube-less create path, inserting the conversations row directly through its own writable pool so agent-host can hydrate the conversation on the first prompt.
type devCreator struct {
	pool *pgxpool.Pool
}

// OpenDevCreator opens the small writable pool for dev-mode creates.
func OpenDevCreator(ctx context.Context, dsn string) (*devCreator, error) {
	if dsn == "" {
		return nil, errors.New("ROUTER_DEV_MODE needs a writable AGENT_HOST_DB DSN (set AGENT_HOST_DB_DSN)")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	cfg.MinConns = 0
	cfg.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &devCreator{pool: pool}, nil
}

func (d *devCreator) Close() {
	if d != nil && d.pool != nil {
		d.pool.Close()
	}
}

// Create inserts a fresh conversations row, the only write this stack makes on create.
func (d *devCreator) Create(ctx context.Context, c NewConversation) error {
	_, err := d.pool.Exec(ctx, insertConversationSQL, conversationRowOf(c, time.Now().UnixMilli()).args()...)
	return err
}
