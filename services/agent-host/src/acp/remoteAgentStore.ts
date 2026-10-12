/**
 * Durable per-user remote-agent binding on the shared Postgres, so the "Connected"
 * badge is correct across replicas and survives a restart. The DB status drives only
 * the badge; routing uses the live registry, so a stale "online" after a crash just
 * falls to the cloud floor. Best-effort: a DB blip degrades the badge to "offline".
 */

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { byoc } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

const { remoteAgents } = byoc;

const log = logger("remoteAgentStore");

export interface RemoteAgentBinding {
  owner: string;
  status: "online" | "offline";
  lastSeen?: string;
}

/** The persistence seam; Postgres below, a fake in tests. */
export interface RemoteAgentStore {
  /** Upsert the owner online. */
  markOnline(owner: string): Promise<void>;
  /** Mark the owner offline. */
  markOffline(owner: string): Promise<void>;
  /** Whether this owner's agent is believed online, false on any error. */
  isOnline(owner: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface PgRemoteAgentStoreConfig {
  dsn: string;
}

/** Postgres-backed store on the BYOC `remote_agents` table (lib/sql/byoc/schema.sql), owning only status/last_seen while byoc-controller owns session_id; all errors are swallowed. */
export function createPgRemoteAgentStore(config: PgRemoteAgentStoreConfig): RemoteAgentStore {
  const pool = createPgPool("remoteAgentStore", { connectionString: config.dsn, max: 2 });
  const db = drizzle(pool);

  return {
    async markOnline(owner) {
      try {
        await db
          .insert(remoteAgents)
          .values({ owner, status: "online", lastSeen: sql`now()` })
          .onConflictDoUpdate({
            target: remoteAgents.owner,
            set: { status: "online", lastSeen: sql`now()` },
          });
      } catch (e) {
        log.error("markOnline failed", { owner, error: formatError(e) });
      }
    },
    async markOffline(owner) {
      try {
        await db
          .update(remoteAgents)
          .set({ status: "offline", lastSeen: sql`now()` })
          .where(eq(remoteAgents.owner, owner));
      } catch (e) {
        log.error("markOffline failed", { owner, error: formatError(e) });
      }
    },
    async isOnline(owner) {
      try {
        const rows = await db
          .select({ status: remoteAgents.status })
          .from(remoteAgents)
          .where(eq(remoteAgents.owner, owner))
          .limit(1);
        return rows[0]?.status === "online";
      } catch (e) {
        log.error("isOnline failed", { owner, error: formatError(e) });
        return false;
      }
    },
    async close() {
      await pool.end().catch(() => {});
    },
  };
}
