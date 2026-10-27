/**
 * The agent tools enabled contribs make wait on the user (contribs' `agent.blockingTools`),
 * rendered by modules/platform.nix as BLOCKING_TOOLS_JSON: tool name -> { kind, title, dismissed }.
 */

import type { BlockingTool } from "../acp/client.js";

/** The table in `raw`, keeping only well-formed rows; unset or malformed JSON is an empty table. */
export function parseBlockingTools(raw: string | undefined, warn?: (msg: string) => void): Record<string, BlockingTool> {
  if (!raw || !raw.trim()) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    warn?.("BLOCKING_TOOLS_JSON is not valid JSON; no tools will block on the user");
    return {};
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
  const out: Record<string, BlockingTool> = {};
  for (const [tool, v] of Object.entries(doc as Record<string, unknown>)) {
    const r = v as Partial<BlockingTool> | null;
    if (typeof r?.kind !== "string" || !r.kind || typeof r.title !== "string" || typeof r.dismissed !== "string") {
      warn?.(`BLOCKING_TOOLS_JSON: dropping malformed row for ${tool}`);
      continue;
    }
    out[tool] = { kind: r.kind, title: r.title, dismissed: r.dismissed };
  }
  return out;
}
