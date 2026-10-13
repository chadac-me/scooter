// Keeps the Assigner's cache honest: LISTEN conversation_assignment, invalidate per row.
package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

const assignChannel = "conversation_assignment"

// triggerRecheck paces retries until the trigger is migrated.
var triggerRecheck = 30 * time.Second

func runAssignListener(ctx context.Context, cfg *pgx.ConnConfig, a *Assigner) {
	log := logger("assign-listen")
	for ctx.Err() == nil {
		conn, err := pgx.ConnectConfig(ctx, cfg)
		if err == nil {
			_, err = conn.Exec(ctx, "listen "+assignChannel)
		}
		if err == nil {
			// Without the trigger nothing invalidates, so stay uncached.
			var ok bool
			err = conn.QueryRow(ctx,
				`SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'conversation_assignment_upd')`).Scan(&ok)
			if err == nil && !ok {
				_ = conn.Close(context.Background())
				log.Warn("assignment trigger missing (migration not applied); routing uncached")
				sleep(ctx, triggerRecheck)
				continue
			}
		}
		if err != nil {
			if conn != nil {
				_ = conn.Close(context.Background())
			}
			if ctx.Err() == nil {
				log.Warn("assignment LISTEN failed; retrying",
					slog.Int("retry_in_ms", int(listenBackoff.Milliseconds())), errAttr(err))
				sleep(ctx, listenBackoff)
			}
			continue
		}
		// Changes made while disconnected were never notified.
		a.SetLive(true)
		log.Info("listening for assignment changes")
		for ctx.Err() == nil {
			n, err := conn.WaitForNotification(ctx)
			if err != nil {
				if ctx.Err() == nil {
					log.Warn("assignment wait failed; reconnecting", errAttr(err))
				}
				break
			}
			a.Invalidate(n.Payload)
		}
		_ = conn.Close(context.Background())
		a.SetLive(false)
		if ctx.Err() == nil {
			sleep(ctx, listenBackoff)
		}
	}
}
