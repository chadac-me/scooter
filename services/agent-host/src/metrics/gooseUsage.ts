/**
 * Reads per-session token usage from goose's SQLite session store
 * ($HOME/.local/share/goose/sessions/sessions.db), since goose does not report usage
 * over ACP. The schema is undocumented, so the reader introspects the columns rather
 * than hard-coding them and returns `undefined` when it cannot find usage, and the
 * DB lives on an ephemeral emptyDir, so usage is read and emitted per run rather
 * than relied on for history.
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import type { TokenUsage } from "./pricing.js";
import { debug, debugError } from "../debug.js";

/** goose's session DB, relative to its $HOME. */
const DB_RELATIVE = [".local", "share", "goose", "sessions", "sessions.db"];

/** Token columns to look for, in preference order (the cumulative accumulated_* columns first). */
const COLS = {
  input: ["accumulated_input_tokens", "input_tokens"],
  output: ["accumulated_output_tokens", "output_tokens"],
  cacheRead: ["accumulated_cache_read_tokens", "cache_read_tokens"],
  cacheWrite: ["accumulated_cache_write_tokens", "cache_write_tokens"],
  total: ["accumulated_total_tokens", "total_tokens"],
} as const;

export interface GooseUsageReaderConfig {
  /** goose's $HOME, which the DB path is resolved relative to. */
  gooseHome: string;
}

export interface GooseUsageReader {
  /** The cumulative token usage recorded for an ACP session id, or `undefined` when the DB, columns or row are not found. */
  readSessionUsage(acpSessionId: string): Promise<TokenUsage | undefined>;

  /** Close any open DB handle. */
  close(): Promise<void>;
}

/** Open a reader over goose's session DB; an absent DB makes readSessionUsage return undefined rather than throw. */
export function createGooseUsageReader(config: GooseUsageReaderConfig): GooseUsageReader {
  const dbPath = join(config.gooseHome, ...DB_RELATIVE);

  // The DB is opened lazily on first read, since goose creates it on its first run.
  let db: DatabaseSync | undefined;
  let available: { table: string; cols: Partial<Record<keyof typeof COLS, string>> } | undefined;
  let openedOnce = false;

  /** Discover the first present column from a candidate list. */
  const pick = (have: Set<string>, candidates: readonly string[]): string | undefined =>
    candidates.find((c) => have.has(c));

  const open = (): boolean => {
    if (openedOnce) return db !== undefined && available !== undefined;
    openedOnce = true;
    try {
      // Read-only so it never contends with goose's writer; throws if absent.
      db = new DatabaseSync(dbPath, { readOnly: true });
      // Introspect the `sessions` table so a schema change degrades to "no cost" rather than a crash.
      const cols = new Set(
        (db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as Array<{ name: string }>).map(
          (r) => r.name,
        ),
      );
      const resolved = {
        input: pick(cols, COLS.input),
        output: pick(cols, COLS.output),
        cacheRead: pick(cols, COLS.cacheRead),
        cacheWrite: pick(cols, COLS.cacheWrite),
        total: pick(cols, COLS.total),
      };
      // Need at least input or total to report anything meaningful.
      if (!resolved.input && !resolved.total) {
        debug("[metrics] goose sessions.db has no token columns; cost disabled");
        return false;
      }
      available = { table: "sessions", cols: resolved };
      return true;
    } catch (err) {
      // An absent DB is expected (goose has not run yet), but a present-but-unreadable
      // one silently disabling cost metrics is worth surfacing.
      if ((err as { code?: string })?.code === "ENOENT") {
        debug("[metrics] goose sessions.db absent (%s); cost will be omitted until goose runs", dbPath);
      } else {
        debugError(`[metrics] goose sessions.db at ${dbPath} unreadable; cost metrics DISABLED:`, err);
      }
      return false;
    }
  };

  return {
    async readSessionUsage(acpSessionId: string): Promise<TokenUsage | undefined> {
      if (!open() || !db || !available) return undefined;
      const { cols } = available;
      // SELECT just the columns found.
      const select: Array<[keyof TokenUsage, string]> = [];
      if (cols.input) select.push(["inputTokens", cols.input]);
      if (cols.output) select.push(["outputTokens", cols.output]);
      if (cols.cacheRead) select.push(["cachedReadTokens", cols.cacheRead]);
      if (cols.cacheWrite) select.push(["cachedWriteTokens", cols.cacheWrite]);
      if (cols.total) select.push(["totalTokens", cols.total]);
      try {
        const sql = `SELECT ${select.map(([, c]) => `"${c}" AS "${c}"`).join(", ")} FROM sessions WHERE id = ? LIMIT 1`;
        const row = db.prepare(sql).get(acpSessionId) as Record<string, number | null> | undefined;
        if (!row) return undefined; // unknown session
        const usage: TokenUsage = {};
        for (const [field, col] of select) {
          const v = row[col];
          if (typeof v === "number") usage[field] = v;
        }
        return usage;
      } catch (err) {
        debugError("[metrics] goose usage read failed:", err);
        return undefined;
      }
    },

    async close(): Promise<void> {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      db = undefined;
    },
  };
}
