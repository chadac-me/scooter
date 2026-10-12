/**
 * Resource-mapping lookup: the fallback source for a conversation's external target
 * when its link has no structured `ref`, read from the webhooks service's
 * `conversation_map` table on the shared Postgres. Read-only and best-effort: any DB
 * error yields `undefined`, so a tool reports an unknown target rather than guess.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { webhooks } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

import type { ResourceMapping } from "./agentTools.js";

const { conversationMap } = webhooks;

const log = logger("resourceLookup");

export interface ResourceLookupConfig {
  /** Postgres connection string (postgresql://user:pass@host:port/db). */
  dsn: string;
}

export interface ResourceLookup {
  /** The webhooks conversation_map row for this conversation and source, or undefined if unmapped or on any DB error. */
  lookup(conversationId: string, source: string): Promise<ResourceMapping | undefined>;
  /** Close the pool on shutdown. */
  close(): Promise<void>;
}

/** Build a Postgres-backed ResourceLookup whose failures are logged and swallowed so a DB blip never breaks a tool call. */
export function createResourceLookup(config: ResourceLookupConfig): ResourceLookup {
  const pool = createPgPool("resourceLookup", { connectionString: config.dsn, max: 3 });
  const db = drizzle(pool);

  return {
    async lookup(conversationId, source) {
      try {
        const rows = await db
          .select({
            source: conversationMap.source,
            resourceType: conversationMap.resourceType,
            resourceId: conversationMap.resourceId,
            slackChannel: conversationMap.slackChannel,
            slackTs: conversationMap.slackTs,
          })
          .from(conversationMap)
          .where(
            and(
              eq(conversationMap.conversationId, conversationId),
              eq(conversationMap.source, source),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) return undefined;
        return {
          source: row.source,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          slackChannel: row.slackChannel ?? undefined,
          slackTs: row.slackTs ?? undefined,
        };
      } catch (err) {
        log.error("query failed (falling back to ref-only)", {
          conversation_id: conversationId,
          source,
          error: formatError(err),
        });
        return undefined;
      }
    },
    async close() {
      await pool.end().catch(() => {});
    },
  };
}
