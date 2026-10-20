/**
 * Fold an event log into AG-UI `Message`s for a MESSAGES_SNAPSHOT, which applies
 * history in one pass where replaying individual events makes the client's applier
 * rebuild and clone the message list on every emit.
 */

import { EventType } from "@ag-ui/core";
import type { AguiEvent } from "../bridge.js";

/** Event types the client's applier routes through its message-mutation path, which a replay must skip; derived from the library's enum so a new upstream type cannot slip past. */
export const MESSAGE_EVENTS: ReadonlySet<string> = new Set(
  Object.values(EventType).filter(
    (t) => t !== EventType.MESSAGES_SNAPSHOT && /MESSAGE|REASONING|TOOL_CALL|TEXT|THINKING/.test(t),
  ),
);

export interface SnapshotMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "reasoning";
  content: string;
  toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  toolCallId?: string;
  /** Epoch ms of the event that opened the message (its `ts`); absent when that event is unstamped. */
  createdAt?: number;
}

/** Fold `events` into messages in emission order. */
export function foldToMessages(events: Iterable<AguiEvent>): SnapshotMessage[] {
  const out: SnapshotMessage[] = [];
  const byId = new Map<string, SnapshotMessage>();
  // A tool call belongs to the assistant message open when it started.
  const toolToAssistant = new Map<string, SnapshotMessage>();
  const toolName = new Map<string, string>();
  const toolArgs = new Map<string, string>();
  // tool_call_id -> the emitted call object, so args arriving after it was built can still be written into it.
  const emittedCalls = new Map<string, { function: { arguments: string } }>();
  let openAssistant: SnapshotMessage | undefined;

  // The event being folded, so `open` can stamp the message with that event's `ts`.
  let ts: unknown;
  const open = (id: string, role: SnapshotMessage["role"]) => {
    const m: SnapshotMessage = { id, role, content: "" };
    if (typeof ts === "number") m.createdAt = ts;
    byId.set(id, m);
    out.push(m);
    return m;
  };

  for (const e of events as Iterable<Record<string, string>>) {
    ts = (e as { ts?: unknown }).ts;
    switch (e.type) {
      case "TEXT_MESSAGE_START": {
        const role = e.role === "user" ? "user" : "assistant";
        const m = open(e.messageId, role);
        if (role === "assistant") openAssistant = m;
        break;
      }
      case "REASONING_START":
      case "REASONING_MESSAGE_START":
        open(e.messageId, "reasoning");
        break;
      case "TEXT_MESSAGE_END":
        // Close the assistant turn, so a tool call that starts after it belongs to the next turn.
        if (openAssistant?.id === e.messageId) openAssistant = undefined;
        break;
      case "TEXT_MESSAGE_CONTENT":
      case "REASONING_MESSAGE_CONTENT": {
        // A log can begin mid-message, so open the message rather than drop the text.
        const m =
          byId.get(e.messageId) ??
          open(e.messageId, e.type === "REASONING_MESSAGE_CONTENT" ? "reasoning" : "assistant");
        m.content += e.delta ?? "";
        break;
      }
      case "TOOL_CALL_START": {
        toolName.set(e.toolCallId, e.toolCallName ?? "");
        if (openAssistant) toolToAssistant.set(e.toolCallId, openAssistant);
        break;
      }
      case "TOOL_CALL_ARGS": {
        const acc = (toolArgs.get(e.toolCallId) ?? "") + (e.delta ?? "");
        toolArgs.set(e.toolCallId, acc);
        // Args can arrive after the call was emitted at TOOL_CALL_END (the shell tool's
        // normal order), so patch the already-emitted call.
        const already = emittedCalls.get(e.toolCallId);
        if (already) already.function.arguments = acc;
        break;
      }
      case "TOOL_CALL_END": {
        const host = toolToAssistant.get(e.toolCallId) ?? openAssistant;
        const call = {
          id: e.toolCallId,
          type: "function" as const,
          function: { name: toolName.get(e.toolCallId) ?? "", arguments: toolArgs.get(e.toolCallId) ?? "" },
        };
        if (host) (host.toolCalls ??= []).push(call);
        else {
          // A tool call with no open assistant message still needs a carrier.
          const m = open(`asst-${e.toolCallId}`, "assistant");
          m.toolCalls = [call];
        }
        // Held by reference so args arriving after this point can still reach it.
        emittedCalls.set(e.toolCallId, call);
        break;
      }
      case "TOOL_CALL_RESULT": {
        // A result whose START/END never made it into the log needs a synthesized carrier.
        if (!toolName.has(e.toolCallId)) {
          const host = openAssistant ?? open(`asst-${e.toolCallId}`, "assistant");
          (host.toolCalls ??= []).push({
            id: e.toolCallId,
            type: "function",
            function: { name: "", arguments: "" },
          });
          toolName.set(e.toolCallId, "");
        }
        const m = open(`tool-${e.toolCallId}`, "tool");
        m.toolCallId = e.toolCallId;
        m.content = e.content ?? "";
        break;
      }
      default:
        break; // RUN_*, QUEUE_UPDATED, CONTEXT_USAGE, SYSTEM_MESSAGE: not messages
    }
  }
  // Drop framing that produced nothing renderable (an opened-but-empty message).
  return out.filter((m) => m.content !== "" || (m.toolCalls?.length ?? 0) > 0 || m.role === "tool");
}

/** How many trailing messages the initial snapshot paints; the rest pages in on scroll. */
export const INITIAL_SNAPSHOT_MESSAGES = 200;

/** Split `events` on the run boundary before the last `messages` messages, returning the trailing slice plus the 1-based seq of its first event for paging older history. */
export function splitForInitialSnapshot(
  events: AguiEvent[],
  messages = INITIAL_SNAPSHOT_MESSAGES,
): { tail: AguiEvent[]; fromSeq: number; hasOlder: boolean } {
  if (messages <= 0 || events.length === 0) {
    return { tail: events, fromSeq: 1, hasOlder: false };
  }
  const OPENS = new Set(["TEXT_MESSAGE_START", "REASONING_START", "REASONING_MESSAGE_START"]);
  let seen = 0;
  let cut = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type as string;
    if (OPENS.has(t) || t === "TOOL_CALL_RESULT") {
      seen++;
      if (seen > messages) {
        cut = i;
        break;
      }
    }
  }
  if (cut === 0) return { tail: events, fromSeq: 1, hasOlder: false };
  let boundary = cut;
  for (let i = cut; i < events.length; i++) {
    if (events[i].type === "RUN_STARTED") {
      boundary = i;
      break;
    }
  }
  if (boundary === 0) return { tail: events, fromSeq: 1, hasOlder: false };
  return { tail: events.slice(boundary), fromSeq: boundary + 1, hasOlder: true };
}

/** The offset of the first RUN_STARTED in a backward page, so the page begins at a whole run, or 0 when the window holds none. */
export function alignPageToRun(events: AguiEvent[]): number {
  const i = events.findIndex((e) => e.type === "RUN_STARTED");
  return i > 0 ? i : 0;
}
