/**
 * The agent-host's inbound tunnel connection: holds `GET /byoc/:id/tunnel` open and
 * serves the container-initiated MCP streams that arrive on it, since the per-prompt
 * HTTP/SSE transport has no channel for a stream the container opens. Replies go back
 * via `POST /byoc/:id/tunnel/:streamId`.
 */

import { formatError, logger } from "../log.js";
import { createTunnelService, type TunnelServiceDeps } from "./tunnelService.js";
import type { WireFrame } from "./remoteProtocol.js";
import { STREAM_IDLE_MS } from "./byocTransport.js";

const log = logger("tunnel");

export interface TunnelClientDeps extends Omit<TunnelServiceDeps, "send"> {
  /** The controller's in-cluster base URL. */
  baseUrl: string;
  /** The container session whose inbound stream this follows. */
  sessionId: string;
  /** The conversation this session serves, the server-side scope for every target it resolves. */
  conversationId: string;
  fetchImpl?: typeof fetch;
  idleMs?: number;
  /** Whether a frame's ACP session (`sid`) belongs to this conversation; the stream carries every conversation's frames. */
  ownsSession?: (sid: string) => boolean;
}

/** Streams remembered as served; replays of older ones are past any timeout. */
const SERVED_MAX = 4096;

/**
 * Admit only this conversation's frames, and each stream's open once. The controller
 * fans one session's stream to every reader and replays its queue to a new or
 * reconnected reader, so serving every frame runs other conversations' tool calls in
 * this conversation's scope and re-runs old ones.
 */
export function createTunnelFrameFilter(ownsSession?: (sid: string) => boolean): (frame: WireFrame) => boolean {
  const served = new Set<string>();
  return (frame) => {
    if (ownsSession) {
      // An unstamped frame cannot be attributed, so serving it would guess a scope.
      if (!frame.sid || !ownsSession(frame.sid)) return false;
    }
    if (frame.type === "open" && frame.id) {
      if (served.has(frame.id)) return false;
      served.add(frame.id);
      if (served.size > SERVED_MAX) served.delete(served.values().next().value as string);
    }
    return true;
  };
}

export interface TunnelClient {
  /** Stop following the stream. */
  close(): void;
}

/** Send each stream's frames one after another, in order; streams stay concurrent. */
export function createOrderedSender(post: (frame: WireFrame) => Promise<void>): (frame: WireFrame) => void {
  const tails = new Map<string, Promise<void>>();
  return (frame) => {
    const id = frame.id;
    if (!id) return;
    // A close that overtook a chunk made the container drop that chunk.
    const next = (tails.get(id) ?? Promise.resolve()).then(() => post(frame));
    const tail = next.catch(() => {});
    tails.set(id, tail);
    if (frame.type === "close") void tail.then(() => tails.get(id) === tail && tails.delete(id));
  };
}

/** Follow a session's inbound tunnel stream, serving each frame and reconnecting on drop. */
export function startTunnelClient(deps: TunnelClientDeps): TunnelClient {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = `${deps.baseUrl.replace(/\/$/, "")}/byoc/${encodeURIComponent(deps.sessionId)}`;
  let closed = false;
  let controller: AbortController | undefined;

  const service = createTunnelService({
    ...deps,
    // Responses ride the reply route, since the stream is inbound-only.
    send: createOrderedSender((frame: WireFrame) =>
      doFetch(`${base}/tunnel/${encodeURIComponent(frame.id ?? "")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(frame),
      })
        .then((res) => {
          // A non-OK reply is a dropped response the container is still waiting on.
          if (!res.ok) {
            log.warn("reply rejected", {
              conversation_id: deps.conversationId,
              session_id: deps.sessionId,
              frame_type: frame.type,
              stream: frame.id,
              status: res.status,
            });
          }
        })
        .catch((err) => {
          log.warn("reply failed", {
            conversation_id: deps.conversationId,
            session_id: deps.sessionId,
            frame_type: frame.type,
            stream: frame.id,
            error: formatError(err),
          });
        }),
    ),
  });

  const idleMs = deps.idleMs ?? STREAM_IDLE_MS;
  const admit = createTunnelFrameFilter(deps.ownsSession);
  const follow = async (): Promise<void> => {
    while (!closed) {
      let idle: NodeJS.Timeout | undefined;
      try {
        const ac = (controller = new AbortController());
        // A silent stream is dead; abort and redial.
        const arm = () => {
          clearTimeout(idle);
          idle = setTimeout(() => ac.abort(new Error(`no bytes for ${idleMs}ms`)), idleMs);
        };
        arm();
        const res = await doFetch(`${base}/tunnel`, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          // A 404 means the session is gone, so stop rather than spin.
          if (res.status === 404) return;
          throw new Error(`tunnel stream ${res.status}`);
        }
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const frame = JSON.parse(line.slice(5).trim()) as WireFrame;
                if (!admit(frame)) continue;
                void service.onFrame(deps.conversationId, frame);
              } catch {
                // One malformed frame must not kill the stream.
              }
            }
          }
        }
      } catch (err) {
        if (closed) return;
        log.warn("inbound stream dropped (reconnecting)", {
          conversation_id: deps.conversationId,
          session_id: deps.sessionId,
          retry_in_ms: 1000,
          error: formatError(err),
        });
      } finally {
        clearTimeout(idle);
      }
      if (closed) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  };

  // Log once per session, since a silent tunnel client looks like one that never started.
  log.info("following inbound stream", {
    conversation_id: deps.conversationId,
    session_id: deps.sessionId,
  });
  void follow();

  return {
    close() {
      closed = true;
      controller?.abort();
    },
  };
}
