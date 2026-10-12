/**
 * The BYOC transport: a RemoteTransport that speaks HTTP/SSE to the BYOC controller,
 * which owns the WebSocket to the user's container, so the pod holds nothing durable
 * and any replica can serve any conversation. Each frame kind has its own endpoint:
 * ACP requests go to POST /byoc/:session/prompt (which streams the run back), a
 * permission ack to /permission/:id, and an exec_result to /exec/:id. Every error
 * path closes the transport, since RemoteAcpClient's onClose is what rejects
 * in-flight requests and lets the bridge emit RUN_ERROR rather than hang.
 */

import type { RemoteTransport, WireFrame } from "./remoteProtocol.js";

export interface ByocTransportConfig {
  /** Base URL of the in-cluster BYOC controller Service, e.g. http://byoc-controller:8080. */
  baseUrl: string;
  /** The controller-issued session id for this owner's container. */
  sessionId: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export function createByocTransport(config: ByocTransportConfig): RemoteTransport {
  const { baseUrl, sessionId } = config;
  const doFetch = config.fetchImpl ?? fetch;
  const base = `${baseUrl.replace(/\/$/, "")}/byoc/${encodeURIComponent(sessionId)}`;

  const frameCbs = new Set<(frame: WireFrame) => void>();
  const closeCbs = new Set<() => void>();
  let open = true;
  const inflight = new Set<AbortController>();

  const emit = (frame: WireFrame): void => {
    if (!open) return;
    for (const cb of [...frameCbs]) cb(frame);
  };

  const shutdown = (): void => {
    if (!open) return;
    open = false;
    for (const ac of inflight) ac.abort();
    inflight.clear();
    for (const cb of [...closeCbs]) cb();
  };

  /** Which endpoint a frame belongs to. */
  const endpointFor = (frame: WireFrame): string => {
    if (frame.ch === "exec" && frame.id) return `${base}/exec/${encodeURIComponent(frame.id)}`;
    // An outbound ACP `ack` is always an answer to a permission the container is blocked on.
    if (frame.ch === "acp" && frame.type === "ack" && frame.id) {
      return `${base}/permission/${encodeURIComponent(frame.id)}`;
    }
    return `${base}/prompt`;
  };

  /** Read an SSE body, dispatching each `data:` line as a frame. */
  const pump = async (res: Response): Promise<void> => {
    const body = res.body;
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line; a frame can span reads.
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            emit(JSON.parse(line.slice(5).trim()) as WireFrame);
          } catch {
            // One bad line must not kill a live run.
          }
        }
      }
    }
  };

  return {
    send(frame) {
      if (!open) return;
      const ac = new AbortController();
      inflight.add(ac);
      void (async () => {
        try {
          const res = await doFetch(endpointFor(frame), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(frame),
            signal: ac.signal,
          });
          if (!res.ok) {
            // Close rather than retry silently, so the bridge tells the user their Claude is offline.
            shutdown();
            return;
          }
          await pump(res);
        } catch {
          if (!ac.signal.aborted) shutdown(); // an abort is our own close(), not a failure
        } finally {
          inflight.delete(ac);
        }
      })();
    },

    onFrame(cb) {
      frameCbs.add(cb);
      return () => frameCbs.delete(cb);
    },

    isOpen() {
      return open;
    },

    onClose(cb) {
      closeCbs.add(cb);
      return () => closeCbs.delete(cb);
    },

    close() {
      shutdown();
    },
  };
}
