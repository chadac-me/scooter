/**
 * Integrity event stream client. Subscribes to the agent-host's
 * GET /conversations/:id/events.integrity, a single ordered JSON SSE stream that
 * replays the full event log and then stays open for live appends, so replay and
 * live cannot race whoever drove the run. Each event carries { prevChecksum, checksum }
 * with checksum_n = sha256(checksum_{n-1} || canonical(event)); a prevChecksum that
 * does not match the running checksum means a dropped or reordered frame, and the
 * client reconnects so the fresh stream re-replays the authoritative log. The stream
 * yields the folded message list (one message per TEXT_MESSAGE_* id) plus a `synced`
 * flag, so the caller can seed the thread.
 */

import type { AgentHostConfig, AguiMessage } from "./client.js";

export const EMPTY_CHECKSUM = "0".repeat(64);

interface IntegrityFrame {
  kind: "event" | "synced";
  event?: Record<string, unknown>;
  prevChecksum?: string;
  checksum?: string;
}

export interface IntegrityUpdate {
  /** Folded messages (oldest first) reflecting the log so far. */
  messages: AguiMessage[];
  /** True once the initial replay is complete (caught up to live). */
  synced: boolean;
  /** The rolling checksum through the last applied event. */
  checksum: string;
}

/** Fold a flat event into the message accumulator (mutates `byId`/`order`). */
function foldEvent(
  e: Record<string, unknown>,
  order: string[],
  byId: Map<string, AguiMessage>,
): void {
  const id = e.messageId as string | undefined;
  if (e.type === "TEXT_MESSAGE_START" && id) {
    if (!byId.has(id)) {
      byId.set(id, { id, role: (e.role as AguiMessage["role"]) ?? "assistant", content: "" });
      order.push(id);
    }
  } else if (e.type === "TEXT_MESSAGE_CONTENT" && id) {
    const m = byId.get(id);
    if (m) m.content += (e.delta as string) ?? "";
  }
}

function snapshot(order: string[], byId: Map<string, AguiMessage>): AguiMessage[] {
  return order.map((id) => ({ ...byId.get(id)! })).filter((m) => m.content.trim() !== "");
}

export interface IntegritySubscription {
  close(): void;
}

/** Open the integrity stream for `conversationId`, firing `onUpdate` with the folded
 *  messages whenever the view changes; the returned handle closes the subscription. */
export function subscribeIntegrity(
  config: AgentHostConfig,
  conversationId: string,
  onUpdate: (u: IntegrityUpdate) => void,
  deps?: { fetchImpl?: typeof fetch; checksumOf?: (prev: string, e: Record<string, unknown>) => Promise<string> },
): IntegritySubscription {
  const base = config.baseUrl.replace(/\/$/, "");
  const url = `${base}/conversations/${encodeURIComponent(conversationId)}/events.integrity`;
  const doFetch = deps?.fetchImpl ?? fetch;

  let closed = false;
  let controller: AbortController | undefined;

  // Folded state.
  let order: string[] = [];
  let byId = new Map<string, AguiMessage>();
  let running = EMPTY_CHECKSUM;
  let synced = false;

  const emit = () => onUpdate({ messages: snapshot(order, byId), synced, checksum: running });

  const reset = () => {
    order = [];
    byId = new Map();
    running = EMPTY_CHECKSUM;
    synced = false;
  };

  const apply = async (frame: IntegrityFrame): Promise<"ok" | "gap"> => {
    if (frame.kind === "synced") {
      synced = true;
      emit();
      return "ok";
    }
    if (frame.kind !== "event" || !frame.event) return "ok";
    // Integrity check: the event must link to the checksum we currently hold.
    if (frame.prevChecksum !== undefined && frame.prevChecksum !== running) {
      return "gap";
    }
    foldEvent(frame.event, order, byId);
    if (frame.checksum) running = frame.checksum;
    emit();
    return "ok";
  };

  // A 404 is either a conversation not created yet (it appears server-side on the
  // first prompt) or a deleted one, so retry with a capped backoff until the caller
  // closes the subscription.
  let notFoundDelay = 500;
  const notFoundCap = 5000;

  const run = async () => {
    while (!closed) {
      controller = new AbortController();
      try {
        const res = await doFetch(url, {
          headers: { Accept: "text/event-stream", ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
          // Firefox makes identical stored GETs wait on a never-ending stream.
          cache: "no-store",
          signal: controller.signal,
        });
        if (res.status === 404) {
          await delay(notFoundDelay);
          notFoundDelay = Math.min(notFoundDelay * 2, notFoundCap);
          continue;
        }
        notFoundDelay = 500; // connected (or non-404 error) — reset the 404 backoff
        if (!res.ok || !res.body) {
          await delay(1000);
          continue;
        }
        reset(); // fresh stream replays the whole log from the seed
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE frames are separated by a blank line; each "data:" line is JSON.
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = raw.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let frame: IntegrityFrame;
            try {
              frame = JSON.parse(line.slice(5).trim()) as IntegrityFrame;
            } catch (e) {
              // A malformed frame is skipped rather than killing the stream, and logged
              // so a lost 'synced' marker is diagnosable.
              console.warn("[integrityStream] dropping unparseable frame:", line.slice(0, 200), e);
              continue;
            }
            const r = await apply(frame);
            if (r === "gap") {
              // A checksum gap: reconnect so the fresh stream re-replays the log.
              controller.abort();
              break;
            }
          }
        }
      } catch {
        /* network drop / abort — fall through to reconnect */
      }
      if (!closed) await delay(500);
    }
  };

  void run();

  return {
    close() {
      closed = true;
      controller?.abort();
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
