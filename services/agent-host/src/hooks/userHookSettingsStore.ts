/** Per-user hook opt-outs; no row means the hook is on. */

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { createPgPool } from "../db/pgPool.js";

const { userHookSettings } = agent_host;

export interface UserHookSettingsStore {
  /** Hook id -> enabled, for the owner's recorded choices. */
  list(owner: string): Promise<Map<string, boolean>>;
  set(owner: string, hookId: string, enabled: boolean): Promise<void>;
  close(): Promise<void>;
}

export function createPgUserHookSettingsStore(config: { dsn?: string; db?: NodePgDatabase; now?: () => number }): UserHookSettingsStore {
  const ownPool = config.db ? undefined : createPgPool("userHookSettingsStore", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);
  const now = config.now ?? (() => Date.now());
  return {
    async list(owner) {
      const rows = await db
        .select({ hookId: userHookSettings.hookId, enabled: userHookSettings.enabled })
        .from(userHookSettings)
        .where(eq(userHookSettings.owner, owner));
      return new Map(rows.map((r) => [r.hookId, r.enabled]));
    },
    async set(owner, hookId, enabled) {
      await db
        .insert(userHookSettings)
        .values({ owner, hookId, enabled, updatedAt: now() })
        .onConflictDoUpdate({
          target: [userHookSettings.owner, userHookSettings.hookId],
          set: { enabled: sql`excluded.enabled`, updatedAt: sql`excluded.updated_at` },
        });
    },
    async close() {
      await ownPool?.end();
    },
  };
}

/** In-memory, for tests. */
export function createMemoryUserHookSettingsStore(): UserHookSettingsStore {
  const rows = new Map<string, Map<string, boolean>>();
  return {
    async list(owner) {
      return new Map(rows.get(owner) ?? []);
    },
    async set(owner, hookId, enabled) {
      if (!rows.has(owner)) rows.set(owner, new Map());
      rows.get(owner)!.set(hookId, enabled);
    },
    async close() {},
  };
}
