/**
 * Tier 2: per-conversation cold Sandbox provisioning against a real cluster.
 *
 * Drives the real provisioner (createK8sProvisioner) and asserts the cluster reconciles it:
 * a unique SA, the workspace PVC bound, the Sandbox pod Ready and exec-able, and the broker
 * token projected. Gated on RUN_CLUSTER_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";
import { createK8sProvisioner } from "../../services/agent-host/src/session/k8sProvisioner.js";
import type { SandboxProvisioner } from "../../services/agent-host/src/session/manager.js";
import type { SandboxRef } from "../../services/agent-host/src/types.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-test";
const IMAGE = process.env.SANDBOX_IMAGE ?? "agent-sandbox-os:latest";

maybe("cold Sandbox per conversation", () => {
  let cluster: Cluster;
  let provisioner: SandboxProvisioner;
  let ref: SandboxRef;
  const id = "testabc123";

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: NS });
    provisioner = createK8sProvisioner({ namespace: NS, sandboxImage: IMAGE });
    ref = await provisioner.create(id);
  }, 60_000);

  afterAll(async () => {
    await provisioner?.destroy(ref).catch(() => {});
  });

  it("creates a unique ServiceAccount sandbox-{id}", async () => {
    const sa = await cluster.waitFor("ServiceAccount", `sandbox-${id}`, () => true, 30_000, NS);
    expect(sa).toBeTruthy();
  });

  it("binds the workspace PVC", async () => {
    const pvc = await cluster.waitFor<{ status: { phase: string } }>(
      "PersistentVolumeClaim",
      `workspace-conv-${id}`,
      (p) => p.status?.phase === "Bound",
      120_000,
      NS,
    );
    expect(pvc.status.phase).toBe("Bound");
  });

  it("brings the Sandbox pod to Ready and is exec-able (no in-pod server)", async () => {
    await cluster.waitFor<{ status: { conditions: Array<{ type: string; status: string }> } }>(
      "Sandbox",
      `conv-${id}`,
      (s) => !!s.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
      180_000,
      NS,
    );
    const { stdout, exitCode } = await cluster.exec(
      `agents.x-k8s.io/sandbox-name=conv-${id}`,
      ["echo", "ready"],
      NS,
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("ready");
  });

  it("projects a broker-audience SA token into the pod", async () => {
    const { stdout, exitCode } = await cluster.exec(
      `agents.x-k8s.io/sandbox-name=conv-${id}`,
      ["cat", "/var/run/secrets/broker/token"],
      NS,
    );
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("a NON-LOGIN exec (bash -c) has the nix profile bin on PATH", async () => {
    // A non-login `bash -c` inherits PID 1's env, so the container-image PATH itself must include the per-user nix profile bin.
    const { stdout, exitCode } = await cluster.exec(
      `agents.x-k8s.io/sandbox-name=conv-${id}`,
      ["bash", "-c", "echo $PATH"],
      NS,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("/workspace/.nix-profile/bin");
  });
});
