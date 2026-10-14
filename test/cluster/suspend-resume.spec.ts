/**
 * Tier 2: suspend drops the Pod but keeps the PVCs, resume re-mounts them, and workspace
 * data survives. Drives the real provisioner.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";
import { createK8sProvisioner } from "../../services/agent-host/src/session/k8sProvisioner.js";
import type { SandboxProvisioner } from "../../services/agent-host/src/session/manager.js";
import type { SandboxRef } from "../../services/agent-host/src/types.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-test";
const IMAGE = process.env.SANDBOX_IMAGE ?? "agent-sandbox-os:latest";
const SELECTOR = (id: string) => `agents.x-k8s.io/sandbox-name=conv-${id}`;
type SandboxStatus = {
  status?: { conditions?: Array<{ type: string; status: string; reason?: string; message?: string }> };
};
const cond = (s: SandboxStatus, type: string) =>
  s.status?.conditions?.find((c) => c.type === type);
const readyP = (s: SandboxStatus) => cond(s, "Ready")?.status === "True";
// Suspension drops the pod, so Ready flips to False or the message says the pod is gone.
const suspendedP = (s: SandboxStatus) => {
  const c = cond(s, "Ready");
  return c?.status === "False" || /pod does not exist|not.?ready/i.test(c?.message ?? c?.reason ?? "");
};

maybe("suspend / resume workspace persistence", () => {
  let cluster: Cluster;
  let provisioner: SandboxProvisioner;
  let ref: SandboxRef;
  const id = "testpersist1";

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: NS });
    provisioner = createK8sProvisioner({ namespace: NS, sandboxImage: IMAGE });
    ref = await provisioner.create(id);
    await cluster.waitFor("Sandbox", `conv-${id}`, readyP, 180_000, NS);
  }, 240_000);

  afterAll(async () => {
    await provisioner?.destroy(ref).catch(() => {});
  });

  it("retains the workspace PVC across suspend (pod dropped, PVC kept)", async () => {
    await cluster.exec(SELECTOR(id), ["sh", "-c", "echo marker > /workspace/marker.txt"], NS);

    await provisioner.suspend(ref);
    await cluster.waitFor("Sandbox", `conv-${id}`, suspendedP, 120_000, NS);

    const pvc = await cluster.get<{ status: { phase: string } }>(
      "PersistentVolumeClaim",
      `workspace-conv-${id}`,
      NS,
    );
    expect(pvc.status.phase).toBe("Bound");
  });

  it("restores workspace data on resume", async () => {
    await provisioner.resume(ref);
    await cluster.waitFor("Sandbox", `conv-${id}`, readyP, 180_000, NS);

    const { stdout } = await cluster.exec(SELECTOR(id), ["cat", "/workspace/marker.txt"], NS);
    expect(stdout.trim()).toBe("marker");
  });

  // The real-PVC end-to-end for what nixos-tests/service-persist.nix proves hermetically.
  it("a service enabled before suspend is RUNNING again after resume (restore oneshot)", async () => {
    // `scooter-service` records the enabled set on the workspace PVC; `terminal` is a lazy tool, so its first start builds in-pod.
    await cluster.exec(SELECTOR(id), ["scooter-service", "start", "terminal"], NS);
    await waitExec(cluster, id, ["systemctl", "is-active", "--quiet", "webservice-terminal.service"], 180_000);

    // The intent is persisted on the PVC.
    const state = await cluster.exec(
      SELECTOR(id),
      ["cat", "/workspace/.scooter/services.json"],
      NS,
    );
    expect(JSON.parse(state.stdout).enabled?.terminal?.autostart).toBe(true);

    // Suspend, then resume into a fresh pod where every explicit-start unit is dead.
    await provisioner.suspend(ref);
    await cluster.waitFor("Sandbox", `conv-${id}`, suspendedP, 120_000, NS);
    await provisioner.resume(ref);
    await cluster.waitFor("Sandbox", `conv-${id}`, readyP, 180_000, NS);

    // The boot `scooter-service-restore` oneshot brought it back without anyone re-issuing a start.
    await waitExec(cluster, id, ["systemctl", "is-active", "--quiet", "webservice-terminal.service"], 180_000);
  });
});

/** Poll an in-pod command until it exits 0, or throw after `timeoutMs`. */
async function waitExec(
  cluster: Cluster,
  id: string,
  command: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await cluster.exec(SELECTOR(id), command, NS);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`waitExec timed out after ${timeoutMs}ms: ${command.join(" ")} — ${String(lastErr)}`);
}
