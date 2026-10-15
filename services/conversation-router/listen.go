// The shared LISTEN loop behind the conversation-list push stream: one dedicated connection
// per channel, reconnecting after any drop. Two channels feed the same stream (conversation
// rows in agent_host, links in webhooks), and they must behave identically on a drop, so the
// loop lives here once rather than once per listener. Why: PR #779.
package main

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5"
)

// dialFunc opens the dedicated connection the loop listens on.
type dialFunc func(context.Context) (*pgx.Conn, error)

// listenLoop listens on channel, handing each payload to onPayload, and returns only when ctx is cancelled.
func listenLoop(ctx context.Context, log *slog.Logger, channel string, dial dialFunc, onPayload func(string)) {
	for ctx.Err() == nil {
		conn, err := dial(ctx)
		if err == nil {
			_, err = conn.Exec(ctx, "listen "+channel)
		}
		if err != nil {
			if conn != nil {
				// Background context: a Close on a cancelled ctx would skip the teardown.
				_ = conn.Close(context.Background())
			}
			if ctx.Err() != nil {
				return
			}
			log.Warn("LISTEN failed; retrying", slog.String("channel", channel),
				slog.Int("retry_in_ms", int(listenBackoff.Milliseconds())), errAttr(err))
			sleep(ctx, listenBackoff)
			continue
		}
		log.Info("listening", slog.String("channel", channel))
		for ctx.Err() == nil {
			n, err := conn.WaitForNotification(ctx)
			if err != nil {
				if ctx.Err() == nil {
					log.Warn("notification wait failed; reconnecting",
						slog.String("channel", channel), errAttr(err))
				}
				break
			}
			onPayload(n.Payload)
		}
		_ = conn.Close(context.Background())
		if ctx.Err() == nil {
			sleep(ctx, listenBackoff)
		}
	}
}
