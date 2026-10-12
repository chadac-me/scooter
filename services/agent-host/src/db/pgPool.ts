/**
 * Shared node-postgres Pool factory with stale-connection hardening: idle
 * connections are evicted after 30s so the pool never hands out one a network idle
 * reaper has silently dropped, and TCP keepalive makes a genuinely dead connection
 * surface as a socket error rather than a query that hangs to the connect timeout.
 * Callers may override any option.
 */

import { formatError, logger } from "../log.js";
import { Pool, type PoolConfig } from "pg";

export interface PgPoolOptions extends PoolConfig {
  /** The connection string (required). */
  connectionString: string;
}

/** Create a hardened pg Pool; `label` tags the non-fatal idle-error log. */
export function createPgPool(label: string, opts: PgPoolOptions): Pool {
  const pool = new Pool({
    // Fail fast if a fresh connect cannot be established.
    connectionTimeoutMillis: 5000,
    // Never reuse a connection idle longer than this.
    idleTimeoutMillis: 30_000,
    // Keep idle connections warm and surface dead ones as socket errors.
    keepAlive: true,
    ...opts,
  });
  // pg emits 'error' on the pool for idle-client failures; log and continue so a DB
  // blip never crashes the process.
  pool.on("error", (err) => {
    logger(label).error("idle pg client error (non-fatal)", { error: formatError(err) });
  });
  return pool;
}
