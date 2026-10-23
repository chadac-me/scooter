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

/** The connect timeout, from PG_CONNECT_TIMEOUT_MS (default 15s). */
export function pgConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PG_CONNECT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
}

/** Create a hardened pg Pool; `label` tags the non-fatal idle-error log. */
export function createPgPool(label: string, opts: PgPoolOptions): Pool {
  const pool = new Pool({
    // Give up on a fresh connect after this; a loaded Postgres can take several seconds.
    connectionTimeoutMillis: pgConnectTimeoutMs(),
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

/** Thrown when Postgres cannot be reached; the HTTP layer answers it with 503. */
export class DbUnavailableError extends Error {
  constructor(op: string, cause: unknown) {
    super(`database unavailable during ${op}`, { cause });
    this.name = "DbUnavailableError";
  }
}

const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH",
  "57P01", "57P02", "57P03", "53300",
]);
const UNAVAILABLE_MESSAGES = [
  /timeout exceeded when trying to connect/i,
  /connection terminated/i,
  /connection timeout/i,
  /Client has encountered a connection error/i,
];

/** Whether `err` (or any error in its cause chain) means Postgres is unreachable, not that the query is wrong. */
export function isDbUnavailable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 8; depth++) {
    if (e instanceof DbUnavailableError) return true;
    const { code, message, cause } = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === "string" && (UNAVAILABLE_CODES.has(code) || code.startsWith("08"))) return true;
    if (typeof message === "string" && UNAVAILABLE_MESSAGES.some((re) => re.test(message))) return true;
    e = cause;
  }
  return false;
}

/** Run an idempotent read, retrying once after `delayMs` when the database is unreachable. */
export async function retryReadOnce<T>(op: string, run: () => Promise<T>, delayMs = 250): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isDbUnavailable(err)) throw err;
    logger("pgPool").warn("read failed on an unreachable database; retrying once", { op, error: formatError(err) });
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      return await run();
    } catch (again) {
      throw isDbUnavailable(again) ? new DbUnavailableError(op, again) : again;
    }
  }
}
