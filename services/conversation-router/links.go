// Read-only access to the resource_links rows the sidebar enriches each conversation with.
// They live in the webhooks database, so this is a second read-only pool, and it is
// optional: without WEBHOOKS_DB_* the list is served as bare rows.
package main

import (
	"context"
	"fmt"
	"net/url"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Link is one linked resource, projected to the four fields the sidebar list shows.
type Link struct {
	Source       string  `json:"source"`
	ResourceType string  `json:"resourceType"`
	URL          *string `json:"url,omitempty"`
	Title        *string `json:"title,omitempty"`
}

// LinkStore is a read-only handle on the webhooks database's resource_links table, nil when not configured.
type LinkStore struct {
	pool *pgxpool.Pool
}

// OpenLinkStore connects the read-only links pool, which the caller must Close.
func OpenLinkStore(ctx context.Context, dsn string) (*LinkStore, error) {
	cfg, err := buildPoolConfig(dsn)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &LinkStore{pool: pool}, nil
}

// linkStoreDSNFromEnv assembles the webhooks DSN from WEBHOOKS_DB_*, "" when not configured.
func linkStoreDSNFromEnv() string {
	if dsn := os.Getenv("WEBHOOKS_DB_DSN"); dsn != "" {
		return dsn
	}
	pw := os.Getenv("WEBHOOKS_DB_PASSWORD")
	if pw == "" {
		return ""
	}
	host := envOr("WEBHOOKS_DB_HOST", "agent-shared-db")
	port := envOr("WEBHOOKS_DB_PORT", "5432")
	name := envOr("WEBHOOKS_DB_NAME", "webhooks")
	user := envOr("WEBHOOKS_DB_USER", "conversation_router")
	dsn := fmt.Sprintf("postgresql://%s:%s@%s:%s/%s",
		url.QueryEscape(user), url.QueryEscape(pw), host, port, name)
	if ssl := os.Getenv("WEBHOOKS_DB_SSLMODE"); ssl != "" {
		dsn += "?sslmode=" + url.QueryEscape(ssl)
	}
	return dsn
}

// LinksByConversation reads every link in one query and groups by conversation id.
func (s *LinkStore) LinksByConversation(ctx context.Context) (map[string][]Link, error) {
	rs, err := s.pool.Query(ctx, `
		SELECT conversation_id, source, resource_type, url, title
		  FROM resource_links`)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	out := map[string][]Link{}
	for rs.Next() {
		var convID string
		var l Link
		if err := rs.Scan(&convID, &l.Source, &l.ResourceType, &l.URL, &l.Title); err != nil {
			return nil, err
		}
		out[convID] = append(out[convID], l)
	}
	return out, rs.Err()
}

// LinksForConversation reads the links of one conversation, returning an empty slice rather than nil.
func (s *LinkStore) LinksForConversation(ctx context.Context, convID string) ([]Link, error) {
	rs, err := s.pool.Query(ctx, `
		SELECT source, resource_type, url, title
		  FROM resource_links
		 WHERE conversation_id = $1`, convID)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	out := []Link{}
	for rs.Next() {
		var l Link
		if err := rs.Scan(&l.Source, &l.ResourceType, &l.URL, &l.Title); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rs.Err()
}

// Close releases the pool and is safe on a nil LinkStore.
func (s *LinkStore) Close() {
	if s != nil && s.pool != nil {
		s.pool.Close()
	}
}
