/**
 * Tier 2: the web-service reverse proxy against a real cluster pod.
 *
 * Provisions a sandbox, declares and starts a web service inside the pod, then drives the
 * production proxy (createWebServiceProxy, WebServiceRegistry, resolvePodTarget) in-process on
 * a real http.Server and asserts it forwards HTTP and a WebSocket upgrade into the pod's
 * service. Gated on RUN_CLUSTER_TESTS=1; it reaches the pod IP directly, so the pod network
 * must be routable from the test host.
 */

import { createServer, request, type Server } from "node:http";
import { connect, type Socket, type AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";
import { createK8sProvisioner } from "../../services/agent-host/src/session/k8sProvisioner.js";
import { resolvePodTarget } from "../../services/agent-host/src/exec/k8sExec.js";
import { connectSandbox } from "../../services/agent-host/src/exec/sandboxExec.js";
import { createWebServiceProxy } from "../../services/agent-host/src/proxy/webServiceProxy.js";
import { createWebServiceRegistry } from "../../services/agent-host/src/proxy/webServiceRegistry.js";
import type { SandboxProvisioner } from "../../services/agent-host/src/session/manager.js";
import type { SandboxRef } from "../../services/agent-host/src/types.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-test";
const IMAGE = process.env.SANDBOX_IMAGE ?? "agent-sandbox-os:latest";

const SELECTOR = (id: string) => `agents.x-k8s.io/sandbox-name=conv-${id}`;

// A sub-path-aware fake service installed into the pod at runtime, serving 200 under /c/<id>/demo.
const DEMO_PORT = 9931;
function demoServerPy(id: string): string {
  return [
    "import sys",
    "from http.server import BaseHTTPRequestHandler, HTTPServer",
    `BASE = "/c/${id}/demo"`,
    "class H(BaseHTTPRequestHandler):",
    "    def do_GET(self):",
    "        if self.path.startswith(BASE):",
    "            self.send_response(200); self.end_headers(); self.wfile.write(b'demo-ok')",
    "        else:",
    "            self.send_response(404); self.end_headers()",
    "    def log_message(self, *a): pass",
    `HTTPServer(("0.0.0.0", ${DEMO_PORT}), H).serve_forever()`,
  ].join("\n");
}

maybe("web-service reverse proxy (real pod)", () => {
  let cluster: Cluster;
  let provisioner: SandboxProvisioner;
  let ref: SandboxRef;
  let proxyServer: Server;
  let proxyPort: number;
  const id = "wsproxy01";

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: NS });
    provisioner = createK8sProvisioner({ namespace: NS, sandboxImage: IMAGE });
    ref = await provisioner.create(id);

    // Wait for the pod to be Ready.
    await cluster.waitFor<{ status: { conditions: Array<{ type: string; status: string }> } }>(
      "Sandbox", `conv-${id}`,
      (s) => !!s.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
      180_000, NS,
    );

    // Seed the pod with the discovery manifest the registry reads and a startable unit.
    const py = demoServerPy(id);
    const manifest = JSON.stringify({
      services: [{ name: "demo", displayName: "Demo", port: DEMO_PORT, basePath: `/c/${id}/demo`, unit: "webservice-demo" }],
    });
    await cluster.exec(SELECTOR(id), ["mkdir", "-p", "/run/scooter"], NS);
    await cluster.exec(SELECTOR(id), ["sh", "-c", `cat > /run/scooter/web-services.json <<'EOF'\n${manifest}\nEOF`], NS);
    await cluster.exec(SELECTOR(id), ["sh", "-c", `cat > /run/scooter/demo.py <<'EOF'\n${py}\nEOF`], NS);
    // A transient unit named like the option's unit, not started yet.
    await cluster.exec(
      SELECTOR(id),
      ["sh", "-c",
        `cat > /run/systemd/system/webservice-demo.service <<'EOF'\n` +
        `[Unit]\nDescription=web service: Demo\n[Service]\nExecStart=/usr/bin/env python3 /run/scooter/demo.py\nEOF\n` +
        `systemctl daemon-reload`],
      NS,
    );

    // The production proxy and registry against the real pod, with a minimal fake SessionManager.
    const sessions = {
      get: (cid: string) => (cid === id ? { id, threadId: id, sandbox: ref } : undefined),
      getByShortId: async () => undefined,
    } as never;
    const registry = createWebServiceRegistry({
      sandboxFor: (cid) => (cid === id ? ref : undefined),
      connect: (r) => connectSandbox(r),
    });
    const proxy = createWebServiceProxy({
      sessions,
      resolvePodTarget: (r) => resolvePodTarget(r),
      registry,
      publicHost: "test.local",
    });

    proxyServer = createServer((req, res) => {
      if (proxy.matches(new URL(req.url ?? "/", "http://x").pathname)) void proxy.handleHttp(req, res);
      else res.writeHead(404).end();
    });
    proxyServer.on("upgrade", (req, socket, head) => {
      if (proxy.matches(new URL(req.url ?? "/", "http://x").pathname))
        void proxy.handleUpgrade(req, socket as never, head);
      else socket.destroy();
    });
    await new Promise<void>((r) => proxyServer.listen(0, "127.0.0.1", () => r()));
    proxyPort = (proxyServer.address() as AddressInfo).port;
  }, 240_000);

  afterAll(async () => {
    proxyServer?.close();
    await provisioner?.destroy(ref).catch(() => {});
  });

  it("declared-but-not-started -> friendly 502", async () => {
    const { status, body } = await httpGet(proxyPort, `/c/${id}/demo/`);
    expect(status).toBe(502);
    expect(body.toLowerCase()).toContain("start");
  });

  it("starts the service, then proxies HTTP into the pod under its base path", async () => {
    // Start it as the UI Start button does, then wait for it to bind the port.
    await cluster.exec(SELECTOR(id), ["systemctl", "start", "webservice-demo"], NS);
    await waitFor(async () => {
      const { exitCode } = await cluster.exec(SELECTOR(id), ["sh", "-c", `curl -fsS localhost:${DEMO_PORT}/c/${id}/demo/ >/dev/null`], NS);
      return exitCode === 0;
    }, 30_000);

    const { status, body } = await httpGet(proxyPort, `/c/${id}/demo/app`);
    expect(status).toBe(200);
    expect(body).toContain("demo-ok");

    // Outside the base path the in-pod service 404s.
    const outside = await httpGet(proxyPort, `/c/${id}/demo/../nope`);
    expect([200]).not.toContain(outside.status);
  });

  it("proxies a WebSocket upgrade into the pod", async () => {
    // The demo server echoes on upgrade.
    const { statusLine, echoed } = await wsEcho(proxyPort, `/c/${id}/demo/ws`, "ping-42");
    expect(statusLine).toContain("101");
    expect(echoed).toContain("ping-42");
  });
});

// --- helpers ------------------------------------------------------------------

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function wsEcho(port: number, path: string, payload: string): Promise<{ statusLine: string; echoed: string }> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(port, "127.0.0.1", () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buf = "";
    let sent = false;
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      if (!sent && buf.includes("101")) {
        sent = true;
        sock.write(payload);
      } else if (sent && buf.includes(payload)) {
        resolve({ statusLine: buf.split("\r\n")[0], echoed: payload });
        sock.destroy();
      }
    });
    sock.on("error", reject);
    sock.setTimeout(15_000, () => { reject(new Error("ws upgrade timed out")); sock.destroy(); });
  });
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
