/**
 * BYOC controller entrypoint, binding the pure HTTP surface (server.ts) to node:http and
 * the container sockets to `ws`. It runs as a single replica: one process owns every
 * container socket, a restart drops them, and the containers reconnect on their own.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { createSessionRegistry } from "./sessionRegistry.js";
import { createRunRelay } from "./runRelay.js";
import { createServer } from "./server.js";
import { createDeviceAuth } from "./deviceAuth.js";
import {
  createPgSessionStore,
  createMemorySessionStore,
  createPgDeviceStore,
  createMemoryDeviceStore,
} from "./sessionStore.js";

const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.BYOC_JOIN_SECRET ?? "";
// Assemble the DSN from parts, since postgres-init writes only a `password` secret; DATABASE_URL is still honoured.
const DSN =
  process.env.DATABASE_URL ??
  (process.env.DB_HOST
    ? `postgresql://${process.env.DB_USER ?? "byoc"}:${encodeURIComponent(process.env.DB_PASSWORD ?? "")}` +
      `@${process.env.DB_HOST}:${process.env.DB_PORT ?? "5432"}/${process.env.DB_NAME ?? "byoc"}` +
      (process.env.DB_SSLMODE ? `?sslmode=${process.env.DB_SSLMODE}` : "")
    : "");

if (!SECRET) {
  console.error("[byoc] BYOC_JOIN_SECRET is required — refusing to start without a signing key");
  process.exit(1);
}

// Durable owner->session mapping when a DSN is configured, in-memory otherwise; the socket is always in-memory.
const store = DSN ? createPgSessionStore({ dsn: DSN }) : createMemorySessionStore();
if (!DSN) console.warn("[byoc] no DATABASE_URL — owner->session mapping will NOT survive a restart");

const registry = createSessionRegistry({ store, secret: SECRET });
const relay = createRunRelay({ registry });
// Device identities let a laptop reconnect without a fresh join token.
const deviceStore = DSN ? createPgDeviceStore({ dsn: DSN }) : createMemoryDeviceStore();
const devices = createDeviceAuth({ store: deviceStore, secret: SECRET });

const api = createServer({ registry, relay, secret: SECRET, devices });

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
};

/** The identity the authed surface passes down; in-cluster callers have none. */
const userFrom = (req: IncomingMessage): { id: string } | undefined => {
  // Set by the ingress auth proxy and absent on the unauthenticated /byoc/ ingress.
  const id = (req.headers["x-auth-request-user"] ?? req.headers["x-forwarded-user"]) as string | undefined;
  return id ? { id } : undefined;
};

const http = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    if (req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    try {
      const result = await api.handle({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        body: await readBody(req),
        user: userFrom(req),
      });

      if (result.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // Flush the head with an SSE comment, since Node buffers it until the first write and a quiet stream would trip the client's headers timeout.
        res.write(": open\n\n");
        // Stop pumping if the agent-host goes away mid-run.
        let clientGone = false;
        res.on("close", () => { clientGone = true; });
        for await (const frame of result.stream) {
          if (clientGone) break;
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        res.end();
        return;
      }

      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.json === undefined ? "" : JSON.stringify(result.json));
    } catch (err) {
      console.error("[byoc] request failed:", err);
      // A thrown handler must not take down the one process holding every container socket.
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  })();
});

// --- Container sockets -------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

http.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const m = /^\/byoc\/ws\/([^/]+)$/.exec(url.pathname);
  if (!m) {
    socket.destroy();
    return;
  }
  const sessionId = decodeURIComponent(m[1]);
  // The token rides as a query param because the check below, not the ingress, is the gate.
  const token = url.searchParams.get("token") ?? "";
  // A registered container signs a server-issued nonce and needs no token; a first-time container presents the join token.
  const deviceId = url.searchParams.get("deviceId");
  const nonce = url.searchParams.get("nonce");
  const signature = url.searchParams.get("signature");
  void (async () => {
  const authorized =
    deviceId && nonce && signature
      ? await api.authorizeDevice(deviceId, nonce, signature)
      : api.authorizeUpgrade(sessionId, token);
  if (!authorized.ok) {
    console.warn(
      `[byoc] upgrade rejected for session ${sessionId} ` +
        `(${deviceId ? `device ${deviceId}` : "join token"}): ${authorized.reason}`,
    );
    // Record the failure so the Settings UI can show it via /byoc/status.
    void api.noteAuthFailure({ deviceId, token, reason: authorized.reason });
    // Reject by completing the upgrade and closing with a code and reason, so the container logs the cause and backs off to the slow auth-retry cadence.
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      ws.close(4001, `auth rejected: ${authorized.reason}`);
    });
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    // Build the adapter once and keep the reference, because detachIfCurrent compares by identity.
    const containerSocket = {
      send: (data: string) => ws.send(data),
      close: (code?: number, reason?: string) => (code ? ws.close(code, reason) : ws.close()),
    };
    // A device-authenticated container attaches by the owner the signature proved; a first-time container uses the token path.
    const attached = deviceId
      ? registry.attachAuthenticated(sessionId, authorized.owner, containerSocket)
      : registry.attach(sessionId, token, containerSocket);
    if (!attached.ok) {
      // Close with a code and reason so the container can log why.
      // eslint-disable-next-line no-console
      console.warn(`[byoc] attach rejected: session=${sessionId} owner=${authorized.owner}: ${attached.reason}`);
      ws.close(4001, `attach rejected: ${attached.reason}`);
      return;
    }
    // The session actually attached can differ from the URL's id on a device re-attach, and every relay wire-up below must use it.
    const liveSessionId = attached.sessionId;
    console.log(`[byoc] container attached: session=${liveSessionId} owner=${authorized.owner}`);
    // Confirm the attach, which the client waits for before logging ready.
    ws.send(JSON.stringify({ type: "connected", payload: { owner: authorized.owner, sessionId: liveSessionId } }));

    ws.on("message", (data) => relay.onContainerFrame(liveSessionId, data.toString()));
    ws.on("close", () => {
      console.log(`[byoc] container gone: session=${liveSessionId}`);
      // End the in-flight runs first so their streams terminate with an error ack, then release the socket.
      relay.onContainerGone(liveSessionId);
      registry.detachIfCurrent(liveSessionId, containerSocket);
    });
    ws.on("error", (e) => console.warn(`[byoc] socket error session=${liveSessionId}: ${e.message}`));
  });
  })();
});

http.listen(PORT, () => console.log(`[byoc] listening on :${PORT}`));

const shutdown = () => {
  console.log("[byoc] shutting down");
  http.close();
  void store.close();
  void deviceStore.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
