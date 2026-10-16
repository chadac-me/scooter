/**
 * Durable conversation metadata on the shared Postgres: the record behind the sidebar
 * list and everything hydrate() rebuilds an in-memory conversation from. pendingQueue
 * (messages still queued at suspend, which revive() re-enqueues) and parentId (the
 * subagent hierarchy) must survive the round trip exactly. Writes are best-effort, but
 * listConversations propagates a failed query rather than answering [] for data that is
 * intact.
 */

import { desc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

import type { ConversationMeta } from "./manager.js";
import type { SessionId, ThreadId } from "../types.js";

const log = logger("metaStore");

const { conversations } = agent_host;

/** The store seam the ConversationStore's meta methods delegate to. */
export interface MetaStore {
  saveMeta(meta: ConversationMeta): Promise<void>;
  listConversations(): Promise<ConversationMeta[]>;
  removeConversation(id: SessionId): Promise<void>;
  close(): Promise<void>;
}


export interface PgMetaStoreConfig {
  /** Postgres connection string, ignored when `db` is supplied. */
  dsn?: string;
  /** Override of the database handle for tests, defaulting to a hardened pool over `dsn`. */
  db?: NodePgDatabase;
  /** File-backed metadata to seed from, once, when Postgres holds no conversations at all. */
  legacy?: Pick<MetaStore, "listConversations">;
}

type MetaRow = {
  id: string;
  threadId: string;
  title: string;
  createdAt: string | number;
  lastActivityAt: string | number;
  model: string | null;
  modelSetBy: string | null;
  owner: string | null;
  parentId: string | null;
  userTitled: boolean | null;
  starred: boolean | null;
  pendingQueue: unknown;
};

export function createPgMetaStore(config: PgMetaStoreConfig): MetaStore {
  // Own the pool only when we made it, so close() cannot end a caller's handle.
  const ownPool = config.db ? undefined : createPgPool("metaStore", { connectionString: config.dsn!, max: 3 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);

  const rowToMeta = (row: MetaRow): ConversationMeta => ({
    id: row.id as SessionId,
    threadId: row.threadId as ThreadId,
    title: row.title,
    // bigint comes back as a string from node-postgres.
    createdAt: Number(row.createdAt),
    lastActivityAt: Number(row.lastActivityAt),
    ...(row.model == null ? {} : { model: row.model }),
    ...(row.modelSetBy === "user" || row.modelSetBy === "agent" ? { modelSetBy: row.modelSetBy } : {}),
    ...(row.owner == null ? {} : { owner: row.owner }),
    ...(row.parentId == null ? {} : { parentId: row.parentId as SessionId }),
    ...(row.userTitled == null ? {} : { userTitled: row.userTitled }),
    ...(row.starred == null ? {} : { starred: row.starred }),
    ...(row.pendingQueue == null
      ? {}
      : {
          pendingQueue:
            typeof row.pendingQueue === "string"
              ? JSON.parse(row.pendingQueue)
              : (row.pendingQueue as ConversationMeta["pendingQueue"]),
        }),
  });

  const rowValues = (meta: ConversationMeta) => {
    const values = {
      id: meta.id,
      threadId: meta.threadId,
      title: meta.title ?? "",
      createdAt: meta.createdAt,
      lastActivityAt: meta.lastActivityAt,
      model: meta.model ?? null,
      modelSetBy: meta.modelSetBy ?? null,
      owner: meta.owner ?? null,
      parentId: meta.parentId ?? null,
      userTitled: meta.userTitled ?? null,
      starred: meta.starred ?? null,
      // A cleared queue must persist as an empty array, not NULL, or revive() would re-deliver the
      // messages.
      pendingQueue: meta.pendingQueue === undefined ? null : meta.pendingQueue,
    };
    return values;
  };

  /** Seed from files; a backfilled conversation has no creator. */
  const backfill = async (metas: ConversationMeta[]): Promise<void> => {
    for (const meta of metas) {
      await db.insert(conversations).values(rowValues(meta)).onConflictDoNothing({ target: conversations.id });
    }
    log.info("backfilled file conversation metadata into postgres", { conversations: metas.length });
  };

  return {
    /** UPDATE, so a straggler save cannot resurrect a removed row. */
    async saveMeta(meta) {
      try {
        await db.update(conversations).set(rowValues(meta)).where(eq(conversations.id, meta.id));
      } catch (e) {
        log.error("saveMeta failed (metadata not persisted)", {
          conversation_id: meta.id,
          error: formatError(e),
        });
      }
    },

    async listConversations() {
      // Not best-effort: answering [] for a failed read blanks a sidebar while the data is intact.
      const res = await db.select().from(conversations).orderBy(desc(conversations.lastActivityAt));
      const rows = (res as MetaRow[]).map(rowToMeta);
      if (rows.length > 0 || !config.legacy) return rows;

      // The table is empty: seed once from the file store so the sidebar is not blank on first
      // boot.
      const legacy = await config.legacy.listConversations();
      if (legacy.length === 0) return rows;
      await backfill(legacy).catch((e) =>
        log.error("metadata backfill failed (serving the file rows anyway)", {
          error: formatError(e),
        }),
      );
      return legacy;
    },

    async removeConversation(id) {
      try {
        await db.delete(conversations).where(eq(conversations.id, id));
      } catch (e) {
        log.error("removeConversation failed (it may reappear on the next hydrate)", {
          conversation_id: id,
          error: formatError(e),
        });
      }
    },

    async close() {
      await ownPool?.end().catch(() => {});
    },
  };
}
