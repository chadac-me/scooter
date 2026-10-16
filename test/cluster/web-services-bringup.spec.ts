/**
 * Tier 2: bringing a web service up from the browser, against a real sandbox pod. PR #799.
 *
 * Drives the production proxy, registry, wake and a real SessionManager in-process, with the
 * sandbox image's own `terminal` service, so the manifest carries the literal
 * `${CONVERSATION_ID}` basePath that web-services.nix writes. The SessionManager hydrates the
 * conversation before its Sandbox exists, the state a replica the router picks can be in.
 * Gated on RUN_CLUSTER_TESTS=1; the pod network must be routable from the test host.
 */

import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";
import { createK8sProvisioner } from "../../services/agent-host/src/session/k8sProvisioner.js";
import { resolvePodTarget } from "../../services/agent-host/src/exec/k8sExec.js";
import { connectSandbox } from "../../services/agent-host/src/exec/sandboxExec.js";
import { createWake, createWebServiceProxy } from "../../services/agent-host/src/proxy/webServiceProxy.js";
import { createWebServiceRegistry } from "../../services/agent-host/src/proxy/webServiceRegistry.js";
import { createSessionManager, type SandboxProvisioner, type SessionManager } from "../../services/agent-host/src/session/manager.js";
import { createFileConversationStore } from "../../services/agent-host/src/session/fileStore.js";
import type { ConversationRecord } from "../../services/agent-host/src/session/conversationRegistry.js";
import type { SandboxRef, SessionId } from "../../services/agent-host/src/types.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-test";
const IMAGE = process.env.SANDBOX_IMAGE ?? "agent-sandbox-os:latest";
const SELF = "agent-host-test";
type SandboxStatus = {
  status?: { conditions?: Array<{ type: string; status: string; reason?: string; message?: string }> };
};
const cond = (s: SandboxStatus, type: string) => s.status?.conditions?.find((c) => c.type === type);
const readyP = (s: SandboxStatus) => cond(s, "Ready")?.status === "True";
const suspendedP = (s: SandboxStatus) => {
  const c = cond(s, "Ready");
  return c?.status === "False" || /pod does not exist|not.?ready/i.test(c?.message ?? c?.reason ?? "");
};

maybe("web-service bring-up from the browser (real pod)", () => {
  const id = "wsbringup01";
  const base = `/c/${id}/terminal`;
  let cluster: Cluster;
  let provisioner: SandboxProvisioner;
  let sessions: SessionManager;
  let ref: SandboxRef;
  let stateDir: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: NS });
    provisioner = createK8sProvisioner({ namespace: NS, sandboxImage: IMAGE });
    stateDir = mkdtempSync(join(tmpdir(), "ws-bringup-"));

    const record: ConversationRecord = {
      id, spec: { owner: "alice", sandboxRef: `conv-${id}` }, phase: "Assigned", hostPod: SELF, generation: 1,
    };
    sessions = createSessionManager({
      provisioner,
      store: createFileConversationStore(stateDir),
      conversationRegistry: {
        register: async () => {},
        setPhase: async () => {},
        list: async () => [record],
        get: async (cid: string) => (cid === id ? record : undefined),
      } as never,
      selfPod: SELF,
    } as never);

    // Hydrate before the Sandbox exists: the entry freezes a namespace-less placeholder.
    expect(await sessions.ensureReadable(id as SessionId)).toBe(true);
    expect(sessions.get(id as SessionId)!.sandbox.namespace).toBe("");

    ref = await provisioner.create(id);
    await cluster.waitFor("Sandbox", `conv-${id}`, readyP, 180_000, NS);

    // Wired as index.ts wires it.
    const registry = createWebServiceRegistry({
      sandboxFor: (cid) => sessions.get(cid as SessionId)?.sandbox,
      connect: (r) => connectSandbox(r),
    });
    const proxy = createWebServiceProxy({
      sessions,
      resolvePodTarget: (r) => resolvePodTarget(r),
      registry,
      publicHost: "test.local",
      wake: createWake({ sessions, provisioner, registry }),
    });
    server = createServer((req, res) => {
      if (proxy.matches(new URL(req.url ?? "/", "http://x").pathname)) void proxy.handleHttp(req, res);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
  }, 300_000);

  afterAll(async () => {
    server?.close();
    await provisioner?.destroy(ref).catch(() => {});
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it("a replica that hydrated mid-create still sees the running sandbox", async () => {
    // Without the refresh the placeholder reads as an asleep pod and the poll never leaves "sandbox".
    const s = await status(port, base);
    expect(s.phase).toBe("service");
    const entry = sessions.get(id as SessionId)!;
    expect(entry.sandbox).toEqual({ name: `conv-${id}`, namespace: NS });
    expect(entry.status).toBe("running");
  }, 60_000);

  it("opening a stopped service serves a loading page that polls the real path, then lands in the app", async () => {
    const page = await get(port, `${base}/`, "text/html");
    expect(page.status).toBe(200);
    expect(page.body).toContain(`"${base}/__scooter_status"`);
    expect(page.body).not.toContain("CONVERSATION_ID");

    // The page's poll, as the browser makes it: terminal is a lazy tool, so its first start builds in-pod.
    await until(async () => (await status(port, base)).running, 240_000);

    const app = await get(port, `${base}/`, "text/html");
    expect(app.status).toBe(200);
    expect(app.body).not.toContain("__scooter_status");
  }, 300_000);

  it("opening a service on a suspended sandbox wakes it", async () => {
    await provisioner.suspend(ref);
    await cluster.waitFor("Sandbox", `conv-${id}`, suspendedP, 120_000, NS);
    // Past the refresh throttle, so the navigation sees the suspend.
    await new Promise((r) => setTimeout(r, 6_000));

    const page = await get(port, `${base}/`, "text/html");
    expect(page.status).toBe(200);
    expect(page.body).toContain("__scooter_status");

    // Nobody else resumes it: the navigation's wake must.
    await cluster.waitFor("Sandbox", `conv-${id}`, readyP, 180_000, NS);
    await until(async () => (await status(port, base)).phase === "service", 120_000);
  }, 360_000);
});

// --- helpers ------------------------------------------------------------------

function get(port: number, path: string, accept = "*/*"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { accept } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function status(port: number, base: string): Promise<{ running: boolean; phase: string; logs: string }> {
  const r = await get(port, `${base}/__scooter_status`, "application/json");
  if (r.status !== 200) throw new Error(`status poll answered ${r.status}: ${r.body}`);
  return JSON.parse(r.body);
}

async function until(pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 1_200));
  }
}
