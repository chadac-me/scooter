/**
 * Feeds an OwnershipTracker from the `conversations` row, the store the append fence checks,
 * so the guard and the fence read one source of truth (no Conversation CR). It loads every
 * assigned row, then LISTENs on `conversation_assignment` (fired on host_pod / host_generation /
 * phase changes and on delete; payload is the id) and re-reads the rows each notification names.
 * A full resync runs on every (re)connect, since changes made while disconnected are never
 * notified, and periodically as a safety net (an INSERT that arrives already assigned, as a
 * subagent's does, fires no notification).
 *
 * All reads go through one queue so they apply in the order they were issued: a read issued
 * after a notification sees that commit, so an older snapshot can never overwrite a newer one.
 */

import { Client, type Pool } from "pg";

import { formatError, logger } from "../log.js";
import { OwnershipTracker } from "./ownershipGuard.js";

import type { SessionId } from "../types.js";

const log = logger("pgOwnershipGuard");

export const ASSIGNMENT_CHANNEL = "conversation_assignment";

/** One conversations row's assignment; hostPod null means unassigned (or released on suspend). */
export interface AssignmentRow {
  id: string;
  hostPod: string | null;
  generation: number;
}

/** Where the guard reads and listens; the pg implementation is createPgAssignmentSource. */
export interface AssignmentSource {
  /** The rows for `ids` (absent ids have no row), or every row with a host_pod when `ids` is undefined. */
  read(ids?: string[]): Promise<AssignmentRow[]>;
  /** LISTEN for assignment changes, reconnecting on failure; onConnected fires once the LISTEN is up
   *  (after every reconnect). Returns stop(). */
  subscribe(h: { onNotify: (id: string) => void; onConnected: () => void; onDisconnected: () => void }): () => void;
}

/** The tracker plus row-backed confirmation. */
export class PgOwnershipTracker extends OwnershipTracker {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Set<string>();
  private flushScheduled = false;

  constructor(selfPod: string, private readonly source: AssignmentSource) {
    super(selfPod);
  }

  /** Re-read `id`'s row now and report whether this pod hosts it; a failed read is false, since the
   *  callers (sweeps that exec into the sandbox) would rather skip a cycle than resurrect a pod. */
  async confirmOwns(id: SessionId): Promise<boolean> {
    try {
      await this.enqueue(() => this.apply([id as string]));
    } catch (err) {
      log.warn("ownership confirm failed; treating as not owned", { conversation_id: id, error: formatError(err) });
      return false;
    }
    return this.owns(id);
  }

  /** A notification named `id`: batch it with any others that arrive in the same tick. */
  notify(id: string): void {
    this.pending.add(id);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    void this.enqueue(async () => {
      this.flushScheduled = false;
      const ids = [...this.pending];
      this.pending.clear();
      if (ids.length) await this.apply(ids);
    }).catch((err) => log.warn("assignment re-read failed; the next resync repairs it", { error: formatError(err) }));
  }

  /** Replace the cache with every assigned row; anything cached but no longer assigned is dropped. */
  resync(): Promise<void> {
    return this.enqueue(async () => {
      const rows = await this.source.read();
      const seen = new Set<string>();
      for (const r of rows) {
        seen.add(r.id);
        this.observeRow(r);
      }
      for (const id of this.cachedIds()) if (!seen.has(id)) this.observe(id, null);
    });
  }

  private async apply(ids: string[]): Promise<void> {
    const rows = await this.source.read(ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // No row means deleted.
    for (const id of ids) this.observeRow(byId.get(id) ?? { id, hostPod: null, generation: 0 });
  }

  private observeRow(r: AssignmentRow): void {
    // Unassigned stays unobserved, like a CR the controller had not assigned yet: canWrite fails open
    // (a new conversation writes before assignment) and owns() is false.
    this.observe(r.id, r.hostPod ? { hostPod: r.hostPod, generation: r.generation } : null);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
}

export interface PgOwnershipGuardOptions {
  /** Safety-net resync period; default 60s. */
  resyncMs?: number;
}

/** Build the tracker for `selfPod` over `source` and start listening; returns the tracker and stop(). */
export function createPgOwnershipGuard(
  selfPod: string,
  source: AssignmentSource,
  opts: PgOwnershipGuardOptions = {},
): { guard: PgOwnershipTracker; stop: () => void } {
  const guard = new PgOwnershipTracker(selfPod, source);
  const resync = () =>
    guard.resync().catch((err) => log.warn("ownership resync failed; retrying on the next tick", { error: formatError(err) }));
  const unsubscribe = source.subscribe({
    onNotify: (id) => guard.notify(id),
    // LISTEN is up before the snapshot, so nothing committed after the snapshot can be missed.
    onConnected: () => void resync(),
    onDisconnected: () => {},
  });
  const timer = setInterval(() => void resync(), opts.resyncMs ?? 60_000);
  timer.unref?.();
  return {
    guard,
    stop: () => {
      clearInterval(timer);
      unsubscribe();
    },
  };
}

/** The pg-backed AssignmentSource: reads through `pool`, LISTENs on a dedicated client. */
export function createPgAssignmentSource(dsn: string, pool: Pool, backoffMs = 2000): AssignmentSource {
  return {
    async read(ids) {
      const res = ids
        ? await pool.query<{ id: string; host_pod: string | null; host_generation: string | number }>(
            "SELECT id, host_pod, host_generation FROM conversations WHERE id = ANY($1)",
            [ids],
          )
        : await pool.query<{ id: string; host_pod: string | null; host_generation: string | number }>(
            "SELECT id, host_pod, host_generation FROM conversations WHERE host_pod IS NOT NULL",
          );
      return res.rows.map((r) => ({ id: r.id, hostPod: r.host_pod, generation: Number(r.host_generation) }));
    },

    subscribe({ onNotify, onConnected, onDisconnected }) {
      let stopped = false;
      let client: Client | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      const reconnect = (why: string, err?: unknown) => {
        const c = client;
        client = undefined;
        if (!c) return; // already handled
        c.removeAllListeners();
        c.on("error", () => {});
        void c.end().catch(() => {});
        onDisconnected();
        if (stopped) return;
        log.warn("assignment LISTEN lost; reconnecting", { why, retry_in_ms: backoffMs, ...(err ? { error: formatError(err) } : {}) });
        retry = setTimeout(connect, backoffMs);
      };
      const connect = () => {
        if (stopped) return;
        const c = new Client({ connectionString: dsn, keepAlive: true });
        client = c;
        c.on("notification", (n) => {
          if (n.channel === ASSIGNMENT_CHANNEL && n.payload) onNotify(n.payload);
        });
        c.on("error", (err) => reconnect("error", err));
        c.on("end", () => reconnect("end"));
        c.connect()
          .then(() => c.query(`LISTEN ${ASSIGNMENT_CHANNEL}`))
          .then(() => {
            if (client !== c) return;
            log.info("listening for assignment changes");
            onConnected();
          })
          .catch((err) => reconnect("connect", err));
      };
      connect();
      return () => {
        stopped = true;
        if (retry) clearTimeout(retry);
        const c = client;
        client = undefined;
        if (c) {
          c.removeAllListeners();
          c.on("error", () => {});
          void c.end().catch(() => {});
        }
      };
    },
  };
}
