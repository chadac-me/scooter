/**
 * The agent-host's inbound tunnel connection: holds `GET /byoc/:id/tunnel` open and
 * serves the container-initiated MCP streams that arrive on it, since the per-prompt
 * HTTP/SSE transport has no channel for a stream the container opens. Replies go back
 * via `POST /byoc/:id/tunnel/:streamId`.
 */

import { formatError, logger } from "../log.js";
import { createTunnelService, type TunnelServiceDeps } from "./tunnelService.js";
import type { WireFrame } from "./remoteProtocol.js";

const log = logger("tunnel");

export interface TunnelClientDeps extends Omit<TunnelServiceDeps, "send"> {
  /** The controller's in-cluster base URL. */
  baseUrl: string;
  /** The container session whose inbound stream this follows. */
  sessionId: string;
  /** The conversation this session serves, the server-side scope for every target it resolves. */
  conversationId: string;
  fetchImpl?: typeof fetch;
}

export interface TunnelClient {
  /** Stop following the stream. */
  close(): void;
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
    send: (frame: WireFrame) => {
      if (!frame.id) return;
      void doFetch(`${base}/tunnel/${encodeURIComponent(frame.id)}`, {
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
        });
    },
  });

  const follow = async (): Promise<void> => {
    while (!closed) {
      try {
        controller = new AbortController();
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
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const frame = JSON.parse(line.slice(5).trim()) as WireFrame;
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
