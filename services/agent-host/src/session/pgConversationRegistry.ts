/**
 * The `conversations` row half of the conversation registry. It wraps the k8s registry
 * rather than replacing it: register() still creates the CR (subagents get theirs only
 * this way), and host_pod / host_generation are written by the controller on the CR, so
 * the writes fan out to both stores while the assignment reads (list/get) stay on the CR.
 */

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

import type {
  ConversationPhase,
  ConversationRecord,
  ConversationRegistry,
  ConversationSpec,
} from "./conversationRegistry.js";

const log = logger("pgConversationRegistry");

const { conversations } = agent_host;

export interface PgConversationRowsConfig {
  /** Postgres connection string (the agent_host database). Ignored when `db` is supplied. */
  dsn?: string;
  /** Override the database handle (tests). Defaults to a small pool over `dsn`. */
  db?: NodePgDatabase;
}

/**
 * Wrap `cr` so every write also lands on the conversations row, CR first so a row failure
 * cannot change what the CR does; row failures are logged and swallowed.
 */
export function withConversationRows(
  cr: ConversationRegistry,
  config: PgConversationRowsConfig,
): ConversationRegistry {
  const pool = config.db ? undefined : createPgPool("conversationRegistry", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(pool!);

  /** Row writes are best-effort by contract; a failure is loud but never propagates. */
  const bestEffort = async (op: string, id: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      log.warn("conversations row write failed", { op, conversation_id: id, error: formatError(err) });
    }
  };

  return {
    async register(id: string, spec: ConversationSpec): Promise<void> {
      await cr.register(id, spec);
      // Only sandbox_ref and creator_pod, since saveMeta owns model/owner/parent_id; absent fields
      // are omitted rather than nulled so an adoption without a sandboxRef cannot erase the ref the
      // router routes by.
      const set: Partial<{ sandboxRef: string; creatorPod: string }> = {};
      if (spec.sandboxRef) set.sandboxRef = spec.sandboxRef;
      if (spec.creatorPod) set.creatorPod = spec.creatorPod;
      if (Object.keys(set).length === 0) return;
      await bestEffort("register", id, () =>
        db.update(conversations).set(set).where(eq(conversations.id, id)),
      );
    },

    async setPhase(id: string, phase: ConversationPhase): Promise<void> {
      await cr.setPhase(id, phase);
      // No 429 coalescing here: setPhase only fires at suspend/revive transitions.
      await bestEffort("setPhase", id, () =>
        db.update(conversations).set({ phase }).where(eq(conversations.id, id)),
      );
    },

    async remove(id: string): Promise<void> {
      await cr.remove(id);
      // Normally a no-op after metaStore.removeConversation, kept so the row alone says the
      // conversation is gone; idempotent.
      await bestEffort("remove", id, () => db.delete(conversations).where(eq(conversations.id, id)));
    },

    // ---- assignment reads stay on the CR ----
    // host_pod / host_generation are the controller's to write and it still writes the CR.
    list(): Promise<ConversationRecord[]> {
      return cr.list();
    },
    get(id: string): Promise<ConversationRecord | undefined> {
      return cr.get(id);
    },
  };
}
