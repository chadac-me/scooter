/**
 * One-shot backfill of conversation event logs from the NFS mirror into Postgres, run
 * from a Job that mounts the mirror read-only. The mirror is the only copy of any history
 * Postgres does not have yet, so `historyMirror.retainForMigration` must stay true until
 * this has reported every conversation loaded. It verifies rather than assumes: a backfill
 * that loads 127 of 128 conversations must not exit 0.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { chainNext, EMPTY_CHECKSUM } from "../agui/integrity.js";
import { formatError, logger } from "../log.js";
import { backfillConversation } from "./eventStore.js";
import type { AguiEvent } from "../bridge.js";
import type { SessionId } from "../types.js";

const log = logger("eventBackfill");

export interface ConversationReport {
  conversationId: string;
  /** Lines in the file (non-empty). */
  lines: number;
  /** Rows the backfill wrote; must equal `lines`. */
  rows: number;
  /** Chain recomputed from the file, independently of the writer. */
  expectedChecksum: string;
  /** Chain the backfill reported; must equal `expectedChecksum`. */
  actualChecksum: string;
  /**
   * Events whose `ts` precedes their predecessor's (a restart seam), reported rather than
   * silently reordered.
   */
  seams: number;
  ok: boolean;
  error?: string;
}

export interface BackfillReport {
  conversations: ConversationReport[];
  /** True only if every conversation verified; the Job's exit code. */
  ok: boolean;
}

/** Parse a log, skipping blank lines; throws on a malformed line so a log we cannot parse fails
 *  loudly. */
export function parseLog(data: string): AguiEvent[] {
  return data
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as AguiEvent;
      } catch (e) {
        throw new Error(`line ${i + 1}: ${JSON.stringify(formatError(e))}`);
      }
    });
}

/** Chain recomputed from the file, independent of what the backfill wrote. */
export function expectedChain(events: AguiEvent[]): string {
  let acc = EMPTY_CHECKSUM;
  for (const e of events) acc = chainNext(acc, e);
  return acc;
}

/** Count restart seams: events whose ts goes backwards. */
export function countSeams(events: AguiEvent[]): number {
  let seams = 0;
  let last: number | undefined;
  for (const e of events) {
    const ts = (e as { ts?: number }).ts;
    if (typeof ts === "number") {
      if (last !== undefined && ts < last) seams++;
      last = ts;
    }
  }
  return seams;
}

/** Backfill every conversation under `mirrorRoot`, verifying each. */
export async function backfillAll(db: NodePgDatabase, mirrorRoot: string): Promise<BackfillReport> {
  const dirs = (await readdir(mirrorRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const conversations: ConversationReport[] = [];

  for (const id of dirs) {
    try {
      const data = await readFile(join(mirrorRoot, id, "events.jsonl"), "utf8");
      const events = parseLog(data);
      const lines = events.length;
      const expected = expectedChain(events);
      const seams = countSeams(events);
      const res = await backfillConversation(
        db,
        id as SessionId,
        data.split("\n").filter((l) => l.trim()),
      );
      const ok = res.rows === lines && res.finalChecksum === expected;
      conversations.push({
        conversationId: id,
        lines,
        rows: res.rows,
        expectedChecksum: expected,
        actualChecksum: res.finalChecksum,
        seams,
        ok,
      });
    } catch (e) {
      // ENOENT (a conversation dir with no log) is not ok: the operator must see a history that
      // cannot be migrated before the volume is reclaimed.
      conversations.push({
        conversationId: id,
        lines: 0,
        rows: 0,
        expectedChecksum: "",
        actualChecksum: "",
        seams: 0,
        ok: false,
        error: JSON.stringify(formatError(e)),
      });
    }
  }

  const report: BackfillReport = { conversations, ok: conversations.every((c) => c.ok) };
  const seamed = conversations.filter((c) => c.seams > 0);
  log.info("backfill complete", {
    conversations: conversations.length,
    events: conversations.reduce((n, c) => n + c.rows, 0),
    failed: conversations.filter((c) => !c.ok).length,
    // These render in append order after the cutover, where the file store rendered them in ts
    // order.
    conversations_with_restart_seams: seamed.length,
    ok: report.ok,
  });
  for (const c of conversations.filter((x) => !x.ok)) {
    log.error("backfill FAILED for a conversation", {
      conversation_id: c.conversationId,
      lines: c.lines,
      rows: c.rows,
      checksum_matches: c.expectedChecksum === c.actualChecksum,
      error: c.error,
    });
  }
  return report;
}
