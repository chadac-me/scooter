/**
 * The deployment's own .scooter ConfigMap is the single converge source at
 * /etc/agent-sandbox/scooter, mounted directly. The provisioner creates no
 * per-conversation module ConfigMap, since anything else at that mount path would
 * shadow the deployment's tools.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner, sandboxManifest } from "../../src/session/k8sProvisioner.js";

/** A fake k8s API recording every ConfigMap create and read. */
function fakeKc() {
  const createdConfigMaps: string[] = [];
  const reads: string[] = [];
  let sandboxBody: unknown;
  const api = {
    createNamespacedServiceAccount: async () => ({}),
    createNamespacedConfigMap: async (p: { body?: { metadata?: { name?: string } } }) => {
      createdConfigMaps.push(p.body?.metadata?.name ?? "");
      return {};
    },
    readNamespacedConfigMap: async (p: { name?: string }) => {
      reads.push(p.name ?? "");
      throw Object.assign(new Error("not found"), { code: 404 });
    },
    // create() reads the CR first to keep a cold Sandbox's size; 404 means none yet.
    getNamespacedCustomObject: async () => {
      throw Object.assign(new Error("not found"), { code: 404 });
    },
    createNamespacedCustomObject: async (p: { body?: unknown }) => {
      sandboxBody = p.body;
      return {};
    },
    readNamespacedPersistentVolumeClaim: async () => ({}),
  };
  return {
    kc: { makeApiClient: () => api as never } as never,
    createdConfigMaps,
    reads,
    sandbox: () => sandboxBody as { spec: { podTemplate: { spec: Record<string, never> } } },
  };
}

const provisioner = (kc: never, scooterConfigMap?: string) =>
  createK8sProvisioner({ namespace: "agent-manager", sandboxImage: "img", kubeConfig: kc, scooterConfigMap });

describe("k8sProvisioner.create — no per-conversation module ConfigMap", () => {
  it("creates no per-conversation module ConfigMap", async () => {
    const { kc, createdConfigMaps } = fakeKc();
    await provisioner(kc, "deploy-scooter").create("conv1", "conv1");
    expect(createdConfigMaps.filter((n) => n.endsWith("-module"))).toEqual([]);
  });

  it("does not read the deployment scooterConfigMap either", async () => {
    // The kubelet delivers every key of the directly mounted CM.
    const { kc, reads } = fakeKc();
    await provisioner(kc, "deploy-scooter").create("conv1", "conv1");
    expect(reads).toEqual([]);
  });

  it("the Sandbox has NO scooter-conv volume or mount", async () => {
    const { kc, sandbox } = fakeKc();
    await provisioner(kc, "deploy-scooter").create("conv1", "conv1");
    const spec = sandbox().spec.podTemplate.spec as unknown as {
      volumes?: Array<{ name: string }>;
      containers: Array<{ volumeMounts?: Array<{ name: string }> }>;
    };
    expect((spec.volumes ?? []).map((v) => v.name)).not.toContain("scooter-conv");
    expect((spec.containers[0].volumeMounts ?? []).map((v) => v.name)).not.toContain("scooter-conv");
  });
});

describe("sandboxManifest — the deployment .scooter mount", () => {
  const render = (deploy: Parameters<typeof sandboxManifest>[8]) =>
    sandboxManifest("id", "conv-id", "sa", "img", "ns", "aud", "10Gi", true, deploy) as {
      spec: { podTemplate: { spec: { volumes?: Array<{ name: string; configMap?: { name: string } }>; containers: Array<{ volumeMounts?: Array<{ name: string; mountPath: string }> }> } } };
    };

  it("mounts the deployment scooterConfigMap at the converge path", () => {
    // The deployment's injected tools reach the pod only through this mount.
    const m = render({ scooterConfigMap: "deploy-scooter" });
    const spec = m.spec.podTemplate.spec;
    const mount = (spec.containers[0].volumeMounts ?? []).find((v) => v.name === "scooter-tools");
    expect(mount?.mountPath).toBe("/etc/agent-sandbox/scooter");
    expect((spec.volumes ?? []).find((v) => v.name === "scooter-tools")?.configMap?.name).toBe("deploy-scooter");
  });

  it("mounts nothing at the converge path when the deployment configures no .scooter CM", () => {
    const spec = render({}).spec.podTemplate.spec;
    const atPath = (spec.containers[0].volumeMounts ?? []).filter(
      (v) => v.mountPath === "/etc/agent-sandbox/scooter",
    );
    expect(atPath).toEqual([]);
  });
});
