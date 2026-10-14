/**
 * A minimal SSE line parser for marimo's execute stream and the fold from its frames to
 * an ExecuteResult, pure and synchronous over the full body text since execute streams
 * are small. marimo's frames:
 *   event: stdout\n data: {"data":"..."}\n\n
 *   event: stderr\n data: {"data":"..."}\n\n
 *   event: done\n   data: {"success":bool,"output":{"data":"..."}}\n\n
 */

import type { ExecuteEvent, ExecuteResult } from "./types.js";

/** Parse a raw SSE body into its typed frames, tolerating CRLF, ignoring unknown event types and skipping a `data:` line whose JSON does not parse. */
export function parseSseEvents(body: string): ExecuteEvent[] {
  const out: ExecuteEvent[] = [];
  let event = "";
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, ""); // strip a trailing CR
    if (line === "") {
      event = ""; // record separator
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      const payload = line.slice("data:".length).trim();
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // not a real data frame
      }
      const o = (json ?? {}) as Record<string, unknown>;
      if (event === "stdout") out.push({ event: "stdout", data: String(o.data ?? "") });
      else if (event === "stderr") out.push({ event: "stderr", data: String(o.data ?? "") });
      else if (event === "done") {
        const output = (o.output ?? {}) as Record<string, unknown>;
        out.push({
          event: "done",
          success: o.success !== false, // only an explicit false fails
          output: String(output.data ?? ""),
        });
      }
    }
  }
  return out;
}

/** Fold the frames into a single result, null if there was no `done` frame. */
export function foldExecute(events: ExecuteEvent[]): ExecuteResult | null {
  let stdout = "";
  let stderr = "";
  let done: { success: boolean; output: string } | undefined;
  for (const e of events) {
    if (e.event === "stdout") stdout += e.data;
    else if (e.event === "stderr") stderr += e.data;
    else if (e.event === "done") done = { success: e.success, output: e.output };
  }
  if (!done) return null;
  return { success: done.success, stdout, stderr, output: done.output };
}
