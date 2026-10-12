/**
 * Reconstruct a plain-text transcript from the persisted AG-UI event log for
 * reinjecting history into a freshly revived agent session, which starts with no
 * memory of prior turns. The transcript folds the user and assistant text turns
 * plus a compact record of tool activity (which tool, its args, a trimmed result),
 * since the tool turns carry the actual work; reasoning, permission and
 * run-control events reference session-scoped state and are skipped.
 */

import type { AguiEvent } from "../bridge.js";

export interface TranscriptTurn {
  role: "user" | "assistant" | "tool";
  text: string;
}

/** Per-field truncation for a tool turn's args/result, so a long build log does not dominate the history. */
const TOOL_FIELD_MAX = 800;

function clip(s: string, max = TOOL_FIELD_MAX): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + `… (${t.length - max} more chars)`;
}

/** Fold a persisted event log into ordered turns: one user/assistant turn per text stream and one `name(args) → result` tool turn per tool call, interleaved in call order, with empty text turns dropped. */
export function foldTurns(events: Iterable<AguiEvent>): TranscriptTurn[] {
  const role = new Map<string, "user" | "assistant">();
  const buf = new Map<string, string>();
  // Tool call accumulators keyed by toolCallId; `index` is the placeholder's position in `turns`.
  const tool = new Map<string, { name: string; args: string; index: number }>();
  const turns: TranscriptTurn[] = [];

  const renderTool = (t: { name: string; args: string }, result?: string): string => {
    const args = t.args.trim();
    const head = args ? `${t.name}(${clip(args)})` : t.name;
    return result !== undefined ? `${head} → ${clip(result)}` : head;
  };

  for (const e of events) {
    switch (e.type) {
      case "TEXT_MESSAGE_START":
        role.set(e.messageId, e.role);
        buf.set(e.messageId, "");
        break;
      case "TEXT_MESSAGE_CONTENT": {
        const prev = buf.get(e.messageId);
        if (prev !== undefined) buf.set(e.messageId, prev + e.delta);
        break;
      }
      case "TEXT_MESSAGE_END": {
        const r = role.get(e.messageId);
        const text = (buf.get(e.messageId) ?? "").trim();
        if (r && text) turns.push({ role: r, text });
        role.delete(e.messageId);
        buf.delete(e.messageId);
        break;
      }
      // Emit the call at START so it interleaves with text, then backfill the result onto the same turn.
      case "TOOL_CALL_START": {
        const entry = { name: e.toolCallName, args: "", index: turns.length };
        tool.set(e.toolCallId, entry);
        turns.push({ role: "tool", text: renderTool(entry) });
        break;
      }
      case "TOOL_CALL_ARGS": {
        const t = tool.get(e.toolCallId);
        if (t) {
          t.args += e.delta;
          turns[t.index] = { role: "tool", text: renderTool(t) };
        }
        break;
      }
      case "TOOL_CALL_RESULT": {
        const t = tool.get(e.toolCallId);
        if (t) turns[t.index] = { role: "tool", text: renderTool(t, e.content) };
        break;
      }
      default:
        break;
    }
  }
  return turns;
}

/** Label for each turn role in the reinjected transcript. */
const ROLE_LABEL: Record<TranscriptTurn["role"], string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

/** Build the history preamble to prepend to the first prompt after a revive, or "" when there are no prior turns; `maxChars` trims from the oldest end and is generous because this history is the only continuity a revived session has. */
export function buildHistoryPreamble(events: Iterable<AguiEvent>, maxChars = 48_000): string {
  const turns = foldTurns(events);
  if (turns.length === 0) return "";

  const lines = turns.map((t) => `${ROLE_LABEL[t.role]}: ${t.text}`);
  let body = lines.join("\n\n");
  if (body.length > maxChars) {
    // Trim from the oldest end and mark the elision.
    body = "…(earlier messages omitted)…\n\n" + body.slice(body.length - maxChars);
  }
  return (
    "[Previous conversation — this session was resumed and you have no memory of it. " +
    "Continue from here; do NOT re-introduce yourself or repeat prior work. Lines prefixed " +
    "`Tool:` record work already done (a tool call and its result).]\n\n" +
    body +
    "\n\n[End of previous conversation. The user's new message follows.]"
  );
}
