/**
 * The container's local MCP proxies, one small HTTP server per offered MCP server. Each
 * listens on an ephemeral 127.0.0.1 port (never 0.0.0.0, since this is a user's machine)
 * and forwards what it receives as `ch:"tunnel"` frames, streaming response chunks as they
 * arrive. The proxies are owned by the session's client and torn down with it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import type { WireFrame } from "./protocol.js";

export interface McpProxyDeps {
  /** Send a tunnel frame to the cloud. */
  send(frame: WireFrame): void;
  /** Subscribe to inbound frames; returns unsubscribe. */
  onFrame(cb: (frame: WireFrame) => void): () => void;
  /** Stamp streams with this session so the cloud attributes them. */
  sessionId?: string;
  /** Optional trace called for each frame sent and each reply, since a dropped tunnel frame is otherwise invisible. */
  trace?: (msg: string) => void;
}

export interface McpProxy {
  /** The name the cloud resolves ("scooter-env"). */
  readonly target: string;
  /** The local URL to hand the SDK (http://127.0.0.1:<port>/). */
  readonly url: string;
  /** Stop listening and fail any in-flight streams. */
  close(): Promise<void>;
}

/** One in-flight request: the HTTP response it must be written back to. */
interface Stream {
  res: ServerResponse;
  headersSent: boolean;
}

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

export async function startMcpProxy(target: string, deps: McpProxyDeps): Promise<McpProxy> {
  const streams = new Map<string, Stream>();

  /** Write the cloud's status/headers once, on whichever frame carries them first. */
  const ensureHead = (s: Stream, payload: { status?: number; headers?: Record<string, string> }) => {
    if (s.headersSent) return;
    s.headersSent = true;
    s.res.writeHead(payload.status ?? 200, payload.headers ?? { "content-type": "application/json" });
  };

  const unsubscribe = deps.onFrame((frame) => {
    if (frame.ch !== "tunnel" || !frame.id) return;
    const s = streams.get(frame.id);
    if (!s) return;
    const payload = (frame.payload ?? {}) as {
      data?: string;
      error?: string;
      status?: number;
      headers?: Record<string, string>;
    };
    if (frame.type === "chunk") {
      deps.trace?.(`<- chunk stream=${frame.id.slice(0, 8)} ${payload.data ? payload.data.length + "b64" : "(empty)"}`);
      ensureHead(s, payload);
      if (payload.data) s.res.write(Buffer.from(payload.data, "base64"));
      return;
    }
    if (frame.type === "close") {
      deps.trace?.(`<- close stream=${frame.id.slice(0, 8)}${payload.error ? " error=" + payload.error : ""}`);
      streams.delete(frame.id);
      if (payload.error) {
        // A dropped tunnel must surface as a tool error the agent can react to, never an unanswered call.
        if (!s.headersSent) {
          s.headersSent = true;
          s.res.writeHead(502, { "content-type": "text/plain" });
        }
        s.res.end(payload.error);
        return;
      }
      ensureHead(s, payload);
      s.res.end();
    }
  });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const id = randomUUID();
      streams.set(id, { res, headersSent: false });
      // If the SDK gives up first, stop tracking.
      res.on("close", () => streams.delete(id));
      const body = await readBody(req).catch(() => Buffer.alloc(0));
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
      const sid = deps.sessionId;
      deps.trace?.(`-> open ${target} ${req.method ?? "GET"} ${req.url ?? "/"} stream=${id.slice(0, 8)} sid=${sid ?? "(none)"}`);
      deps.send({
        ch: "tunnel",
        type: "open",
        id,
        ...(sid ? { sid } : {}),
        payload: { target, method: req.method ?? "GET", path: req.url ?? "/", headers },
      });
      if (body.length) {
        deps.send({ ch: "tunnel", type: "chunk", id, payload: { data: body.toString("base64") } });
      }
      // Signal the request is complete; `close` would end the whole stream before the response came back.
      deps.send({ ch: "tunnel", type: "end", id, payload: {} });
      deps.trace?.(`-> end stream=${id.slice(0, 8)} (awaiting cloud reply)`);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    target,
    url: `http://127.0.0.1:${port}/`,
    async close() {
      unsubscribe();
      // Fail anything in flight rather than leaving the SDK pending on a dead proxy.
      for (const [id, s] of streams) {
        streams.delete(id);
        if (!s.headersSent) s.res.writeHead(502, { "content-type": "text/plain" });
        s.res.end("mcp tunnel closed");
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function startMcpProxies(
  offered: Array<{ name: string; url?: string }>,
  deps: McpProxyDeps,
): Promise<{
  servers: Array<{ type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }>;
  close: () => Promise<void>;
}> {
  const proxies = await Promise.all(offered.map((o) => startMcpProxy(o.name, deps)));
  return {
    // `headers` stays empty: the agent-host injects the credential when it proxies, so this machine never holds a conversation token.
    servers: proxies.map((p) => ({ type: "http" as const, name: p.target, url: p.url, headers: [] })),
    close: async () => {
      await Promise.all(proxies.map((p) => p.close().catch(() => undefined)));
    },
  };
}
