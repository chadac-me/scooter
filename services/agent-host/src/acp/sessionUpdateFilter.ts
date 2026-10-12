/**
 * Keeps `session/update` variants the pinned ACP SDK cannot parse off its parser.
 * The SDK validates the whole notification against a closed zod union before
 * `Client.sessionUpdate` is called, rejecting any unknown discriminant with
 * JSON-RPC -32602, so tolerating one has to happen upstream: this filter drops
 * those notifications off the message stream before the SDK decodes them.
 */

import type { Stream } from "@zed-industries/agent-client-protocol";

/** The `sessionUpdate` discriminants the pinned SDK accepts; `sessionUpdateFilter.spec.ts` derives the same set from the SDK's zod schema and fails if the two disagree. */
export const SDK_SESSION_UPDATE_VARIANTS: ReadonlySet<string> = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
]);

/** A notification the SDK would have rejected, surfaced so the caller can salvage it. */
export interface UnsupportedSessionUpdate {
  sessionId: string;
  /** The `sessionUpdate` discriminant, e.g. "usage_update". */
  variant: string;
  /** The raw `params.update` object. */
  update: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The update when `msg` is an id-less `session/update` notification carrying a variant the SDK cannot parse, else undefined (a message with an `id` expects a response and must never be dropped). */
export function unsupportedSessionUpdate(msg: unknown): UnsupportedSessionUpdate | undefined {
  if (!isRecord(msg)) return undefined;
  if (msg.method !== "session/update" || "id" in msg) return undefined;
  const params = msg.params;
  if (!isRecord(params)) return undefined;
  const update = params.update;
  if (!isRecord(update)) return undefined;
  const variant = update.sessionUpdate;
  if (typeof variant !== "string" || SDK_SESSION_UPDATE_VARIANTS.has(variant)) return undefined;
  return {
    sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
    variant,
    update,
  };
}

/** Wrap a `Stream` so unparseable `session/update` notifications are removed from the readable side, in order, with `onDropped` called for each (a throw there is swallowed). */
export function filterUnsupportedSessionUpdates(
  stream: Stream,
  onDropped: (dropped: UnsupportedSessionUpdate) => void,
): Stream {
  const transform = new TransformStream<unknown, unknown>({
    transform(msg, controller) {
      const dropped = unsupportedSessionUpdate(msg);
      if (!dropped) {
        controller.enqueue(msg);
        return;
      }
      try {
        onDropped(dropped);
      } catch {
        // A throw here must not tear down the ACP connection.
      }
    },
  });
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(transform as never) as Stream["readable"],
  };
}

const finiteNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Salvage a dropped `usage_update` (the ACP spec's `used`/`size`) as `context_usage` numbers, or undefined when the shape disagrees. */
export function contextUsageFromUsageUpdate(
  dropped: UnsupportedSessionUpdate,
): { usedTokens: number; contextWindow: number } | undefined {
  if (dropped.variant !== "usage_update") return undefined;
  const usedTokens = finiteNumber(dropped.update.used);
  const contextWindow = finiteNumber(dropped.update.size);
  if (usedTokens === undefined || contextWindow === undefined || contextWindow <= 0) {
    return undefined;
  }
  return { usedTokens, contextWindow };
}
