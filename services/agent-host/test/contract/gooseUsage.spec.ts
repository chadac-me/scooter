/**
 * Reading token usage from goose's sessions.db. The reader introspects the schema
 * rather than hard-coding it, so these tests pin it against a fixture DB (built with
 * node:sqlite) and prove graceful degradation when the DB or its columns are absent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGooseUsageReader } from "../../src/metrics/gooseUsage.js";

let home: string;
let dbPath: string;

/** Create the goose sessions.db layout under a fake $HOME with goose's schema, filling the cumulative `accumulated_*` columns. */
function seedGooseDb(
  rows: Array<{ id: string; input: number; output: number; cacheRead?: number; cacheWrite?: number }>,
) {
  const dir = join(home, ".local", "share", "goose", "sessions");
  mkdirSync(dir, { recursive: true });
  dbPath = join(dir, "sessions.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      working_dir TEXT NOT NULL DEFAULT '',
      total_tokens INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      accumulated_total_tokens INTEGER,
      accumulated_input_tokens INTEGER,
      accumulated_output_tokens INTEGER,
      accumulated_cache_read_tokens INTEGER,
      accumulated_cache_write_tokens INTEGER,
      accumulated_cost REAL,
      provider_name TEXT,
      model_config_json TEXT
    );
  `);
  const ins = db.prepare(
    `INSERT INTO sessions
       (id, name, working_dir, accumulated_input_tokens, accumulated_output_tokens,
        accumulated_cache_read_tokens, accumulated_cache_write_tokens, accumulated_total_tokens)
     VALUES (?, ?, '/workspace', ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    const in_ = r.input;
    const out = r.output;
    const cr = r.cacheRead ?? 0;
    const cw = r.cacheWrite ?? 0;
    ins.run(r.id, r.id, in_, out, cr, cw, in_ + out + cr + cw);
  }
  db.close();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "goosehome-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("goose usage reader", () => {
  it("reads accumulated input/output/cache token usage for a session id", async () => {
    seedGooseDb([{ id: "sess-abc", input: 1200, output: 340, cacheRead: 500, cacheWrite: 60 }]);
    const reader = createGooseUsageReader({ gooseHome: home });

    const usage = await reader.readSessionUsage("sess-abc");

    expect(usage?.inputTokens).toBe(1200);
    expect(usage?.outputTokens).toBe(340);
    expect(usage?.cachedReadTokens).toBe(500);
    expect(usage?.cachedWriteTokens).toBe(60);
    await reader.close();
  });

  it("returns undefined for an unknown session (no false 0)", async () => {
    seedGooseDb([{ id: "sess-abc", input: 10, output: 20 }]);
    const reader = createGooseUsageReader({ gooseHome: home });

    expect(await reader.readSessionUsage("sess-missing")).toBeUndefined();
    await reader.close();
  });

  it("degrades gracefully when the DB doesn't exist (no goose run yet)", async () => {
    // The DB file is absent.
    const reader = createGooseUsageReader({ gooseHome: home });

    expect(await reader.readSessionUsage("sess-anything")).toBeUndefined();
    await reader.close();
  });

  it("degrades gracefully when the schema lacks token columns", async () => {
    const dir = join(home, ".local", "share", "goose", "sessions");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "sessions.db"));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT);");
    db.prepare("INSERT INTO sessions (id, name) VALUES (?, ?)").run("sess-abc", "x");
    db.close();

    const reader = createGooseUsageReader({ gooseHome: home });
    expect(await reader.readSessionUsage("sess-abc")).toBeUndefined();
    await reader.close();
  });
});
