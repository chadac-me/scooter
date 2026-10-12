/**
 * Agent transcript recorder: captures the raw messages crossing the agent boundary
 * (goose ACP frames, claude SDK messages) and the bridge's emitted AG-UI events,
 * correlated by runId, so tests can replay real behavior instead of hand-authored
 * fakes. Off unless TRANSCRIPT_RECORD_DIR is set, in which case one NDJSON file is
 * written per run at <dir>/<conversationId>-<runId>.ndjson.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** One recorded line: `layer` says which seam it came from and `data` is that seam's raw payload. */
export interface TranscriptEntry {
  /** ms since the recorder was created. */
  t: number;
  /** Monotonic sequence across the whole run, all layers interleaved. */
  seq: number;
  layer: "acp-in" | "sdk-in" | "agui-out";
  provider: "goose" | "claude";
  /** The conversation and run this entry belongs to. */
  conversationId: string;
  runId: string;
  /** The raw frame, message or event, serialized as-is. */
  data: unknown;
}

export interface Recorder {
  /** True when a dir was configured, so callers can skip building an entry that would be discarded. */
  readonly enabled: boolean;
  /** Record one entry (a no-op when disabled); `t`/`seq` are stamped internally. */
  record(entry: Omit<TranscriptEntry, "t" | "seq">): void;
}

const NOOP: Recorder = { enabled: false, record: () => {} };

/** Create a recorder writing to `dir` (empty means a no-op recorder) that swallows every filesystem error; `now` is injectable for tests. */
export function createRecorder(dir: string | undefined, now: () => number = Date.now): Recorder {
  if (!dir) return NOOP;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return NOOP; // disable rather than throw
  }
  const start = now();
  let seq = 0;
  return {
    enabled: true,
    record(partial) {
      try {
        const entry: TranscriptEntry = { t: now() - start, seq: seq++, ...partial };
        const file = join(dir, `${partial.conversationId}-${partial.runId}.ndjson`);
        appendFileSync(file, JSON.stringify(entry) + "\n");
      } catch {
        /* recording must never break the run */
      }
    },
  };
}
