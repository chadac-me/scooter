/** Client for POST /reserve; never throws, misses get fresh PVs. */

import { readFileSync } from "node:fs";

import { formatError, logger } from "../log.js";

const log = logger("warmStore");

export interface WarmStoreOptions {
  /** The controller's base URL, e.g. http://warm-store-controller.ns.svc.cluster.local:8080. */
  url: string;
  /** Projected SA token, re-read each call since it rotates. */
  tokenPath?: string;
  /** How long to wait for a reservation before giving up. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export interface Reservation {
  pv: string | null;
  pool: string | null;
  reason: string;
}

export type ReserveFn = (sandbox: string, tag: string) => Promise<Reservation | undefined>;

export function createWarmStoreReserver(opts: WarmStoreOptions): ReserveFn {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const url = `${opts.url.replace(/\/$/, "")}/reserve`;
  return async (sandbox, tag) => {
    const started = Date.now();
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.tokenPath) headers.authorization = `Bearer ${readFileSync(opts.tokenPath, "utf8").trim()}`;
      const res = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ sandbox, tag }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = (await res.json()) as Reservation;
      log.info("reserved an overlay volume", { sandbox, pv: out.pv, pool: out.pool, reason: out.reason, ms: Date.now() - started });
      return out;
    } catch (e) {
      log.warn("warm-store reserve failed; the sandbox gets a fresh overlay volume", {
        sandbox,
        ms: Date.now() - started,
        error: formatError(e),
      });
      return undefined;
    }
  };
}
