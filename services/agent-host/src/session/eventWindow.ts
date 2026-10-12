/**
 * Window a persisted AG-UI event log to its recent tail for fast first paint. The UI
 * folds events into messages, so a naive "last N events" slice could start mid-message;
 * slicing on run boundaries keeps every message and tool call in the window complete,
 * and the tail folds identically to a full replay of those runs.
 */

import type { AguiEvent } from "../bridge.js";

/**
 * Keep the events of the last `runs` runs; `runs <= 0` returns [] and fewer runs than asked
 * for returns the whole log.
 */
export function tailByRuns(events: AguiEvent[], runs: number): AguiEvent[] {
  if (runs <= 0) return [];
  const ordered = orderByTime(events);
  // Index of each RUN_STARTED.
  const starts: number[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].type === "RUN_STARTED") starts.push(i);
  }
  if (starts.length <= runs) return ordered.slice(starts[0] ?? 0);
  // Slice from the RUN_STARTED that begins the last `runs` runs.
  return ordered.slice(starts[starts.length - runs]);
}

/** Number of runs (RUN_STARTED markers) in the log. */
export function runCount(events: AguiEvent[]): number {
  return events.reduce((n, e) => n + (e.type === "RUN_STARTED" ? 1 : 0), 0);
}

/**
 * Split a log into [older, recent] keeping the last `keepRuns` runs verbatim in `recent`;
 * with no more than keepRuns runs, `older` is empty.
 */
export function splitByRuns(events: AguiEvent[], keepRuns: number): { older: AguiEvent[]; recent: AguiEvent[] } {
  const ordered = orderByTime(events);
  const starts: number[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].type === "RUN_STARTED") starts.push(i);
  }
  if (keepRuns <= 0) return { older: ordered, recent: [] };
  if (starts.length <= keepRuns) return { older: [], recent: ordered };
  const cut = starts[starts.length - keepRuns];
  return { older: ordered.slice(0, cut), recent: ordered.slice(cut) };
}

/**
 * Stable-sort a log by each event's `ts`, so the tail window is robust when append order
 * diverges from real time; events with no `ts` keep their position and a fully unstamped
 * log is returned unchanged.
 */
export function orderByTime(events: AguiEvent[]): AguiEvent[] {
  // Fast path: nothing stamped, so do not reorder.
  if (!events.some((e) => typeof e.ts === "number")) return events;
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const ta = a.event.ts;
      const tb = b.event.ts;
      // Missing ts sorts as its neighbor so it never jumps the log.
      if (typeof ta === "number" && typeof tb === "number" && ta !== tb) return ta - tb;
      return a.index - b.index; // stable tie-break
    })
    .map((x) => x.event);
}
