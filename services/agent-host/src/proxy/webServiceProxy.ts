/**
 * Web-service reverse proxy: forwards `/c/<id>/<service>/...` from the browser into
 * the conversation's sandbox pod over HTTP and WebSocket. It lives in the agent-host
 * because only the agent-host can resolve <id> to a pod IP. It attaches to
 * agui/server.ts as an HTTP fallback before the 404 and as the `upgrade` listener.
 * Auth is whatever the ingress already applied; there is no extra per-conversation check.
 * Nothing on the forwarding path execs into the pod: liveness is read off the
 * connection. Why: PR #791.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import type { SessionManager } from "../session/manager.js";
import type { SandboxRef } from "../types.js";

// --- pod target resolution ----------------------------------------------------

/** A conversation pod's reachable address for direct in-cluster HTTP/WS. */
export interface PodTarget {
  name: string;
  /** status.podIP, which changes across suspend/resume. */
  podIP: string;
}

/** Resolve a sandbox ref to its pod name + IP (exec/k8sExec.ts resolvePodTarget). */
export type ResolvePodTarget = (ref: SandboxRef) => Promise<PodTarget>;

// --- service discovery (id + name -> port) -----------------------------------

/** One proxyable service as declared by the in-pod `webServices` option (the discovery manifest entry rendered by web-services.nix). */
export interface WebServiceDescriptor {
  name: string;
  displayName: string;
  /** In-pod listen port. */
  port: number;
  /** External sub-path prefix, with the conversation id substituted in. */
  basePath: string;
  /** systemd unit name (webservice-<name>), for start/stop via exec. */
  unit: string;
  /** Strip the `/c/<id>/<name>` prefix before forwarding, for a service that cannot be told its base path (code-server). */
  stripBasePath?: boolean;
  /** What this service declares it needs (webServices.<name>.resources), advisory only. */
  resources?: { cpu?: string; memory?: string; gpu?: number };
}

/**
 * Reads a conversation's declared web services from the in-pod discovery manifest
 * (/run/scooter/web-services.json) via exec/download and caches them per conversation.
 * The cache expires after MANIFEST_TTL_MS, a start drops it immediately, and
 * list({force}) re-reads on demand.
 */
export interface WebServiceRegistry {
  /** Declared services; `force` re-reads the in-pod manifest instead of the cache. */
  list(conversationId: string, opts?: { force?: boolean }): Promise<WebServiceDescriptor[]>;
  get(conversationId: string, name: string): Promise<WebServiceDescriptor | null>;
  /** Liveness via `systemctl is-active webservice-<name>`. */
  isRunning(conversationId: string, name: string): Promise<boolean>;
  /** Start the unit via `systemctl start webservice-<name>`, resolving once issued rather than once healthy. */
  start(conversationId: string, name: string): Promise<void>;
  /** Stop the unit via `systemctl stop webservice-<name>`. */
  stop(conversationId: string, name: string): Promise<void>;
  /** The unit's recent journal for the loading page, or "" if the read fails. */
  logs(conversationId: string, name: string, lines?: number): Promise<string>;
  /** Whether the sandbox pod is actually Ready (a trivial exec succeeds), as opposed to merely requested. */
  ready(conversationId: string): Promise<boolean>;
  /** Drop cached descriptors for a conversation (on suspend/resume/start). */
  invalidate(conversationId: string): void;
}

// --- the proxy ----------------------------------------------------------------

export interface WebServiceProxyDeps {
  sessions: SessionManager;
  resolvePodTarget: ResolvePodTarget;
  registry: WebServiceRegistry;
  /** The external host from PUBLIC_URL, for absolute-URL correctness. */
  publicHost: string;
  /** Bring a down sandbox back up (what the UI's "Start sandbox" does); absent, a navigation to an asleep pod gets a plain 503. */
  wake?: (conversationId: string) => Promise<void>;
}

/** Parsed shape of a proxy path: /c/<id>/<service>/<rest...> */
export interface ParsedProxyPath {
  conversationId: string;
  service: string;
  /** The remainder after /c/<id>/<service>, with its leading slash (or "/"). */
  rest: string;
}

/** Split a URL path into its proxy parts, or null when it has no service segment (`/c/<id>` alone is the UI deep-link space). */
export function parseProxyPath(pathname: string): ParsedProxyPath | null {
  const parts = pathname.split("/").filter(Boolean);
  // ["c", "<id>", "<service>", ...rest]
  if (parts.length < 3 || parts[0] !== "c") return null;
  const conversationId = decodeURIComponent(parts[1]);
  const service = decodeURIComponent(parts[2]);
  if (!conversationId || !service) return null;
  const restParts = parts.slice(3);
  const rest = "/" + restParts.map(encodeURIComponent).join("/");
  return { conversationId, service, rest };
}

export interface WebServiceProxy {
  matches(pathname: string): boolean;
  handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
}

/** A proxy request resolved to its pod target, or why not: `asleep` means the pod is down, so it carries what the wake and loading page need. */
type Resolution =
  | { ok: true; conversationId: string; podIP: string; port: number; rest: string; stripBasePath: boolean; threadId: string; service: string; basePath: string }
  | { ok: false; kind: "asleep"; conversationId: string; service: string; basePath: string; threadId: string }
  | { ok: false; kind: "error"; status: 404; service: string; threadId: string };

/** The reserved sub-path (under /c/<id>/<service>/) the loading page polls for readiness and the unit's journal. */
export const STATUS_SEGMENT = "__scooter_status";

const htmlEscape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));

/** Whether this request is a top-level browser navigation (wants HTML) rather than an XHR/asset fetch. */
export function wantsHtml(accept: string | undefined): boolean {
  return (accept ?? "").includes("text/html");
}

/** The `/c/<id>/<service>` prefix exactly as the browser addressed it. Not the manifest's basePath, which carries an unexpanded `${CONVERSATION_ID}`. */
export function requestBasePath(p: ParsedProxyPath): string {
  return `/c/${encodeURIComponent(p.conversationId)}/${encodeURIComponent(p.service)}`;
}

/** The self-refreshing loading page shown while a just-started service comes up: it polls `<basePath>/__scooter_status`, shows the unit's journal, and reloads into the app once running. */
export function renderLoadingPage(service: string, basePath: string): string {
  const safe = htmlEscape(service);
  const base = basePath.replace(/\/$/, "");
  const statusUrl = `${base}/${STATUS_SEGMENT}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Starting ${safe}…</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font-family:system-ui,sans-serif;max-width:44rem;margin:12vh auto;padding:0 1rem;color:#222}
 .row{display:flex;align-items:center;gap:.6rem}
 .spin{width:1.1rem;height:1.1rem;border:2px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:s .8s linear infinite}
 @keyframes s{to{transform:rotate(360deg)}}
 pre{background:#0b1020;color:#cbd5e1;padding:.75rem 1rem;border-radius:.5rem;overflow:auto;max-height:22rem;font-size:.8rem;line-height:1.35;white-space:pre-wrap}
 .muted{color:#64748b;font-size:.85rem}
</style></head><body>
<div class="row"><div class="spin"></div><h2 style="margin:0">Starting ${safe}…</h2></div>
<p class="muted">The sandbox and service are coming up — this page will load it automatically. Recent log:</p>
<pre id="log">(waiting for output…)</pre>
<p class="muted">Unit: <code>webservice-${safe}</code></p>
<script>
 const STATUS = ${JSON.stringify(statusUrl)};
 const logEl = document.getElementById("log");
 async function tick() {
   try {
     const r = await fetch(STATUS, { cache: "no-store", headers: { accept: "application/json" } });
     const j = await r.json();
     if (j.logs && j.logs.trim()) logEl.textContent = j.logs;
     else if (j.phase === "sandbox") logEl.textContent = "(starting the sandbox…)";
     if (j.running) { location.reload(); return; }
   } catch (e) { /* transient; keep polling */ }
   setTimeout(tick, 1200);
 }
 tick();
</script>
</body></html>`;
}

export function createWebServiceProxy(deps: WebServiceProxyDeps): WebServiceProxy {
  const { sessions, resolvePodTarget, registry, wake } = deps;

  // Wake/start kicks from navigations and the loading page's 1.2s poll, at most one per key per
  // window: revive and `systemctl start` are not free, and a wake already in flight covers later polls.
  const KICK_THROTTLE_MS = 15_000;
  const lastKick = new Map<string, number>();
  const kick = (key: string, fn: () => Promise<void>) => {
    const now = Date.now();
    if (now - (lastKick.get(key) ?? 0) < KICK_THROTTLE_MS) return;
    lastKick.set(key, now);
    void fn().catch(() => {}); // best-effort; the poll re-kicks after the window
  };
  const wakeSandbox = (conversationId: string) => {
    if (wake) kick(`wake:${conversationId}`, () => wake(conversationId));
  };
  const startService = (conversationId: string, service: string) =>
    kick(`start:${conversationId}/${service}`, () => registry.start(conversationId, service));

  const matches = (pathname: string): boolean => parseProxyPath(pathname) !== null;

  // Proxy traffic marks the conversation active so the idle-suspend sweep does not pull
  // the pod out from under a live session, throttled per conversation so a chatty
  // WebSocket does not hammer the store.
  const TOUCH_THROTTLE_MS = 15_000;
  const lastTouch = new Map<string, number>();
  const touch = (conversationId: string) => {
    const now = Date.now();
    if (now - (lastTouch.get(conversationId) ?? 0) < TOUCH_THROTTLE_MS) return;
    lastTouch.set(conversationId, now);
    sessions.touchById(conversationId as never);
  };

  // The URL id may be the full threadId or the short hash; a full id this pod has not loaded is
  // hydrated (read-only) so a deep link to a cold conversation does not 404.
  async function lookup(urlId: string) {
    const known = sessions.get(urlId) ?? (await sessions.getByShortId(urlId));
    if (known) return known;
    if (!(await sessions.ensureReadable(urlId as never).catch(() => false))) return undefined;
    return sessions.get(urlId);
  }

  async function resolve(pathname: string): Promise<Resolution | null> {
    const parsed = parseProxyPath(pathname);
    if (!parsed) return null;
    const { conversationId, service, rest } = parsed;

    const conv = await lookup(conversationId);
    const threadId = conv?.threadId ?? conversationId;
    if (!conv) return { ok: false, kind: "error", status: 404, service, threadId };
    const basePath = requestBasePath(parsed);
    await sessions.refreshSandbox?.(conv.id);

    const desc = await registry.get(conv.id, service);
    if (!desc) {
      // An unreadable manifest usually means the pod is down, not that the service is undeclared.
      if (!(await registry.ready(conv.id).catch(() => false))) {
        return { ok: false, kind: "asleep", conversationId: conv.id, service, basePath, threadId };
      }
      return { ok: false, kind: "error", status: 404, service, threadId };
    }

    // Deliberately no liveness check: a refused connection below is the answer, and
    // asking first costs a pod exec (~0.7s). Why: PR #791.
    let target: PodTarget;
    try {
      target = await resolvePodTarget(sessions.get(conv.id)?.sandbox ?? conv.sandbox);
    } catch {
      // Pod suspended, not ready, or without an IP.
      return { ok: false, kind: "asleep", conversationId: conv.id, service, basePath, threadId };
    }
    return { ok: true, conversationId: conv.id, podIP: target.podIP, port: desc.port, rest, stripBasePath: desc.stripBasePath ?? false, threadId, service, basePath };
  }

  /** The readiness/log endpoint the loading page polls; returns true if it handled the request. */
  async function handleStatus(pathname: string, res: ServerResponse): Promise<boolean> {
    const parsed = parseProxyPath(pathname);
    if (!parsed || parsed.rest !== `/${STATUS_SEGMENT}`) return false;
    const conv = await lookup(parsed.conversationId);
    if (!conv) {
      res.writeHead(404).end();
      return true;
    }
    const reply = (body: { running: boolean; logs: string; phase: "sandbox" | "service" }) =>
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        .end(JSON.stringify(body));
    await sessions.refreshSandbox?.(conv.id);

    // The poll drives the whole bring-up: wake the sandbox until its pod is ready, then start the
    // unit, so a page opened on a cold conversation lands in the app without anyone clicking Start.
    if (!(await registry.ready(conv.id).catch(() => false))) {
      wakeSandbox(conv.id);
      reply({ running: false, logs: "", phase: "sandbox" });
      return true;
    }
    const [running, logs] = await Promise.all([
      registry.isRunning(conv.id, parsed.service).catch(() => false),
      registry.logs(conv.id, parsed.service).catch(() => ""),
    ]);
    if (!running && (await registry.get(conv.id, parsed.service).catch(() => null))) {
      startService(conv.id, parsed.service);
    }
    reply({ running, logs, phase: "service" });
    return true;
  }

  /** The unit is down: a navigation gets an auto-start plus the loading page, while
      an XHR/asset fetch gets a plain 502 since an HTML page would corrupt it. */
  async function serveNotRunning(
    req: IncomingMessage,
    res: ServerResponse,
    r: { conversationId: string; service: string; basePath: string },
  ): Promise<void> {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (!wantsHtml(req.headers.accept)) {
      res.writeHead(502, { "content-type": "text/plain" }).end(`${r.service} is not running`);
      return;
    }
    // Best-effort start; the loading page polls readiness regardless.
    await registry.start(r.conversationId, r.service).catch(() => {});
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      .end(renderLoadingPage(r.service, r.basePath));
  }

  /** Whether an upstream error means nothing is listening, as opposed to a connection
      that broke mid-flight: only the former says anything about the unit. */
  function nothingListening(err: NodeJS.ErrnoException): boolean {
    return err.code === "ECONNREFUSED" || err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH";
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Answer the loading page's poll before the normal resolve, which would 502 while the unit is down.
    if (await handleStatus(url.pathname, res)) return;

    const r = await resolve(url.pathname);
    if (!r) {
      res.writeHead(404).end();
      return;
    }
    if (!r.ok) {
      if (r.kind === "asleep") {
        // A navigation wakes the sandbox and waits on the loading page, whose poll starts the unit
        // once the pod is ready; an XHR/asset fetch just gets the 503.
        if (wake && wantsHtml(req.headers.accept)) {
          wakeSandbox(r.conversationId);
          const page = renderLoadingPage(r.service, r.basePath);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
        } else {
          res.writeHead(503, { "content-type": "text/plain" })
            .end(`${r.service} is asleep — resume the conversation and try again.`);
        }
      } else {
        res.writeHead(404).end();
      }
      return;
    }

    // Live web-service traffic counts as activity.
    touch(r.conversationId);

    // Preserve the full external path for a sub-path-aware service, or forward only the
    // remainder when stripBasePath is set so the service serves at root.
    const upstreamPath = (r.stripBasePath ? r.rest : url.pathname) + (url.search ?? "");
    const headers = { ...req.headers, host: `${r.podIP}:${r.port}` };
    const upstream = httpRequest(
      { host: r.podIP, port: r.port, method: req.method, path: upstreamPath, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err: NodeJS.ErrnoException) => {
      // Nothing listening means the unit is down; the stale descriptors go with it.
      if (!res.headersSent && nothingListening(err)) {
        registry.invalidate(r.conversationId);
        void serveNotRunning(req, res, r);
        return;
      }
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream error");
    });
    req.pipe(upstream);
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const r = await resolve(url.pathname);
    if (!r || !r.ok) {
      // A WebSocket to a dead/unreachable service just fails; the navigation that owns
      // the page handles the auto-start.
      const status = !r ? 404 : r.kind === "asleep" ? 503 : r.status;
      const text = status === 503 ? "service asleep" : "not found";
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    // Touch on connect and again on data (throttled) so ongoing use keeps the pod
    // alive while an open-but-silent socket holds it for only one window.
    touch(r.conversationId);
    const conversationId = r.conversationId;

    // Splice: open a raw TCP connection to the pod, replay the upgrade handshake with
    // the Host rewritten, forward the buffered head, then pipe both ways.
    const upstreamPath = (r.stripBasePath ? r.rest : url.pathname) + (url.search ?? "");
    const upstream: Socket = connect(r.port, r.podIP, () => {
      const lines = [
        `${req.method ?? "GET"} ${upstreamPath} HTTP/1.1`,
        `Host: ${r.podIP}:${r.port}`,
      ];
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "host") continue;
        for (const val of Array.isArray(v) ? v : [v]) if (val != null) lines.push(`${k}: ${val}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) upstream.write(head);
      // Frames in either direction count as active use.
      const onData = () => touch(conversationId);
      socket.on("data", onData);
      upstream.on("data", onData);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const teardown = () => { socket.destroy(); upstream.destroy(); };
    upstream.on("error", (err: NodeJS.ErrnoException) => {
      // As before the socket just fails; the navigation owns the auto-start.
      if (nothingListening(err)) registry.invalidate(conversationId);
      teardown();
    });
    socket.on("error", teardown);
  }

  return { matches, handleHttp, handleUpgrade };
}
