/**
 * The durable half of a BYOC session: which owner has which session id, and whether it was
 * last seen online. The socket is not here; liveness comes from the in-memory socket map and
 * this table serves the mapping and the UI badge. Every error is swallowed, so a DB blip
 * degrades the badge rather than breaking a live connection.
 */

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { byoc } from "@scooter/schema";
import { Pool } from "pg";

import type { DeviceRow, DeviceStore } from "./deviceAuth.js";

const { remoteAgents } = byoc;

export interface SessionRow {
  owner: string;
  sessionId: string;
  status: "online" | "offline";
}

export interface SessionStore {
  put(owner: string, sessionId: string): Promise<void>;
  setStatus(owner: string, status: "online" | "offline"): Promise<void>;
  getByOwner(owner: string): Promise<SessionRow | null>;
  close(): Promise<void>;
}

/** In-memory store for local dev and tests. */
export function createMemorySessionStore(): SessionStore {
  const rows = new Map<string, SessionRow>();
  return {
    async put(owner, sessionId) {
      rows.set(owner, { owner, sessionId, status: "offline" });
    },
    async setStatus(owner, status) {
      const r = rows.get(owner);
      if (r) r.status = status;
    },
    async getByOwner(owner) {
      return rows.get(owner) ?? null;
    },
    async close() {
      rows.clear();
    },
  };
}

export interface PgSessionStoreConfig {
  dsn: string;
}

export function createPgSessionStore(config: PgSessionStoreConfig): SessionStore {
  // `keepAlive` plus a bounded pool, so a postgres restart does not kill the engine permanently.
  const pool = new Pool({ connectionString: config.dsn, max: 4, keepAlive: true });
  // The table is declared in lib/sql/byoc/schema.sql and provisioned by the migrate job, so a column rename there is a compile error here.
  const db = drizzle(pool);

  return {
    async put(owner, sessionId) {
      try {
        await db
          .insert(remoteAgents)
          .values({ owner, sessionId, status: "offline", lastSeen: sql`now()` })
          .onConflictDoUpdate({
            target: remoteAgents.owner,
            set: { sessionId, status: "offline", lastSeen: sql`now()` },
          });
      } catch {
        /* best effort; the in-memory registry still serves this process */
      }
    },

    async setStatus(owner, status) {
      try {
        await db
          .update(remoteAgents)
          .set({ status, lastSeen: sql`now()` })
          .where(eq(remoteAgents.owner, owner));
      } catch {
        /* best effort */
      }
    },

    async getByOwner(owner) {
      try {
        const rows = await db
          .select({ owner: remoteAgents.owner, sessionId: remoteAgents.sessionId, status: remoteAgents.status })
          .from(remoteAgents)
          .where(eq(remoteAgents.owner, owner))
          .limit(1);
        const row = rows[0];
        if (!row?.sessionId) return null;
        return {
          owner: row.owner,
          sessionId: row.sessionId,
          status: row.status === "online" ? "online" : "offline",
        };
      } catch {
        return null; // a DB blip reads as no durable session, never as a wrong one
      }
    },

    async close() {
      await pool.end().catch(() => {});
    },
  };
}


// --- Device store ------------------------------------------------------------------------------

/** In-memory device store for local dev and tests. */
export function createMemoryDeviceStore(): DeviceStore {
  const rows = new Map<string, DeviceRow>();
  return {
    async add(d) { rows.set(d.id, { ...d }); },
    async listByOwner(owner) { return [...rows.values()].filter((r) => r.owner === owner).map((r) => ({ ...r })); },
    async getById(id) { const r = rows.get(id); return r ? { ...r } : undefined; },
    async remove(id) { rows.delete(id); },
    async touch(id, at) { const r = rows.get(id); if (r) r.lastSeen = at; },
    async close() { rows.clear(); },
  };
}

/**
 * Postgres-backed device store, a separate table from `remote_agents` because devices are
 * 1:N per owner. Unlike the session store it is not best-effort: a device row is the
 * credential, so errors propagate and the caller fails closed.
 */
export function createPgDeviceStore(config: PgSessionStoreConfig): DeviceStore {
  const pool = new Pool({ connectionString: config.dsn, max: 4, keepAlive: true });
  const db = drizzle(pool);

  const toRow = (r: typeof byoc.remoteAgentDevices.$inferSelect): DeviceRow => ({
    id: r.id,
    owner: r.owner,
    publicKey: r.publicKey,
    label: r.label ?? undefined,
    // The generated binding maps timestamptz as an ISO string, not a Date.
    lastSeen: Math.floor(new Date(r.lastSeen).getTime() / 1000),
  });

  return {
    async add(d) {
      await db.insert(byoc.remoteAgentDevices).values({
        id: d.id,
        owner: d.owner,
        publicKey: d.publicKey,
        label: d.label ?? null,
        lastSeen: sql`to_timestamp(${d.lastSeen})`,
      });
    },

    async listByOwner(owner) {
      const rows = await db
        .select()
        .from(byoc.remoteAgentDevices)
        .where(eq(byoc.remoteAgentDevices.owner, owner));
      return rows.map(toRow);
    },

    async getById(id) {
      const rows = await db
        .select()
        .from(byoc.remoteAgentDevices)
        .where(eq(byoc.remoteAgentDevices.id, id));
      return rows[0] ? toRow(rows[0]) : undefined;
    },

    async remove(id) {
      await db.delete(byoc.remoteAgentDevices).where(eq(byoc.remoteAgentDevices.id, id));
    },

    async touch(id, at) {
      // last_seen drives both the settings list and which device gets evicted at the cap.
      await db
        .update(byoc.remoteAgentDevices)
        .set({ lastSeen: sql`to_timestamp(${at})` })
        .where(eq(byoc.remoteAgentDevices.id, id));
    },

    async close() {
      await pool.end().catch(() => {});
    },
  };
}
