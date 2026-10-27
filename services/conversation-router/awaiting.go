// Read-only access to which conversations wait on the user's answer, the sidebar's "!".
// The table lives in the database a contrib provides as `awaiting-input`
// (AWAITING_INPUT_DB_NAME), so this is another read-only pool beside agent_host's, on the
// router's own role, plus a LISTEN on its trigger's channel. Without it there is no "!".
package main

import (
	"context"
	"net/url"
	"os"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// awaitingChannel is the NOTIFY channel the awaiting-input trigger sends `{"conversationId"}` on.
const awaitingChannel = "conversation_awaiting_input_changed"

// AwaitingStore is a read-only handle on conversation_awaiting_input, nil when no contrib provides it.
type AwaitingStore struct {
	pool       *pgxpool.Pool
	connConfig *pgx.ConnConfig
}

// awaitingStoreDSNFromEnv is the agent_host DSN pointed at AWAITING_INPUT_DB_NAME, "" when either is unset.
func awaitingStoreDSNFromEnv() string {
	name := os.Getenv("AWAITING_INPUT_DB_NAME")
	base := storeDSNFromEnv()
	if name == "" || base == "" {
		return ""
	}
	u, err := url.Parse(base)
	if err != nil {
		return ""
	}
	u.Path = "/" + name
	return u.String()
}

// OpenAwaitingStore connects the read-only pool, which the caller must Close.
func OpenAwaitingStore(ctx context.Context, dsn string) (*AwaitingStore, error) {
	cfg, err := buildPoolConfig(dsn)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &AwaitingStore{pool: pool, connConfig: cfg.ConnConfig}, nil
}

// NewListenConn opens a dedicated read-only connection for the awaiting-input LISTEN loop.
func (s *AwaitingStore) NewListenConn(ctx context.Context) (*pgx.Conn, error) {
	return pgx.ConnectConfig(ctx, s.connConfig)
}

// fill sets AwaitingInputAt on rows from one query; a nil store or a failed read leaves them unset.
func (s *AwaitingStore) fill(ctx context.Context, rows []ConversationRow) {
	if s == nil || len(rows) == 0 {
		return
	}
	ids := make([]string, len(rows))
	for i := range rows {
		ids[i] = rows[i].ID
	}
	rs, err := s.pool.Query(ctx,
		`SELECT conversation_id, since FROM conversation_awaiting_input WHERE conversation_id = ANY($1)`, ids)
	if err != nil {
		logger("awaiting").Warn("awaiting-input read failed; rows served without the \"!\"", errAttr(err))
		return
	}
	defer rs.Close()
	since := map[string]int64{}
	for rs.Next() {
		var id string
		var at int64
		if err := rs.Scan(&id, &at); err != nil {
			logger("awaiting").Warn("awaiting-input scan failed", errAttr(err))
			return
		}
		since[id] = at
	}
	for i := range rows {
		if at, ok := since[rows[i].ID]; ok {
			rows[i].AwaitingInputAt = &at
		}
	}
}

// fillOne is fill for a single, possibly nil, row.
func (s *AwaitingStore) fillOne(ctx context.Context, c *ConversationRow) {
	if c == nil {
		return
	}
	rows := []ConversationRow{*c}
	s.fill(ctx, rows)
	*c = rows[0]
}

// Close releases the pool and is safe on a nil AwaitingStore.
func (s *AwaitingStore) Close() {
	if s != nil && s.pool != nil {
		s.pool.Close()
	}
}

// runAwaitingListener pushes a conversation's row whenever its wait is set or cleared, returning when ctx is cancelled or no store is configured.
func runAwaitingListener(ctx context.Context, store *Store, links *LinkStore, hub *sseHub) {
	if store == nil || store.awaiting == nil {
		return
	}
	log := logger("awaiting-listen")
	listenLoop(ctx, log, awaitingChannel, store.awaiting.NewListenConn, func(payload string) {
		// Same `{"conversationId"}` shape as a link change.
		id, ok := linkNotifyDecision(payload)
		if !ok {
			return
		}
		pushUpsert(ctx, id, store, links, hub, log)
	})
}
