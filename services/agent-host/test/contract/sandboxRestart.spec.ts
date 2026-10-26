/**
 * Sandbox restart and staleness: pendingRestart() reports what a restart would pick up (a newer
 * image, a recorded size the running pod lacks), restart() cycles the pod onto both and waits for
 * it, and a transient image-reconcile failure is retried before the sandbox runs as-is.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner, sameResources } from "../../src/session/k8sProvisioner.js";

type Resources = { requests?: Record<string, string>; limits?: Record<string, string> };

interface ClusterState {
  image: string;
  mode: "Running" | "Suspended";
  /** The CR's recorded resources. */
  resources?: Resources;
  /** The live pod, if any, with the resources it was started with. */
  pod?: { resources?: Resources };
}

/** A stateful fake apiserver: Suspended removes the pod, Running starts one from the CR. */
function fakeCluster(init: ClusterState, opts: { failImagePatches?: number; failCode?: number } = {}) {
  const state: ClusterState = structuredClone(init);
  const modes: string[] = [];
  let imagePatchAttempts = 0;
  let failuresLeft = opts.failImagePatches ?? 0;
  const api = {
    getNamespacedCustomObject: async () => ({
      spec: {
        operatingMode: state.mode,
        podTemplate: { spec: { containers: [{ name: "sandbox", image: state.image, resources: state.resources }] } },
      },
    }),
    patchNamespacedCustomObject: async (args: { body: { spec: Record<string, unknown> } }) => {
      const spec = args.body.spec as {
        operatingMode?: "Running" | "Suspended";
        podTemplate?: { spec?: { containers?: Array<{ image?: string; resources?: Resources }> } };
      };
      const containers = spec.podTemplate?.spec?.containers;
      if (containers) {
        imagePatchAttempts++;
        if (failuresLeft > 0) {
          failuresLeft--;
          throw Object.assign(new Error("Too Many Requests"), { code: opts.failCode ?? 429 });
        }
        state.image = containers[0].image ?? state.image;
      }
      if (spec.operatingMode) {
        modes.push(spec.operatingMode);
        state.mode = spec.operatingMode;
        if (state.mode === "Suspended") state.pod = undefined;
        else state.pod ??= { resources: structuredClone(state.resources) };
      }
      return {};
    },
    listNamespacedPod: async () => ({
      items: state.pod
        ? [
            {
              spec: { containers: [{ name: "sandbox", resources: state.pod.resources }] },
              status: { phase: "Running", containerStatuses: [{ ready: true }] },
            },
          ]
        : [],
    }),
    readNamespacedPod: async () => {
      throw Object.assign(new Error("nf"), { code: 404 });
    },
  };
  return {
    kc: { makeApiClient: () => api as never } as never,
    state,
    modes,
    imagePatchAttempts: () => imagePatchAttempts,
  };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({
    namespace: "agent-manager",
    sandboxImage: "sandbox-os:new",
    kubeConfig: kc,
    podPollMs: 1,
    reconcileRetryDelaysMs: [1, 1],
  });

const ref = { name: "conv-abc", namespace: "agent-manager" };
const small: Resources = { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "1", memory: "2Gi" } };
const big: Resources = { requests: { cpu: "4", memory: "8Gi" }, limits: { cpu: "4", memory: "8Gi" } };

describe("sameResources", () => {
  it("compares cpu and memory by value, since the apiserver canonicalizes pod quantities", () => {
    expect(sameResources({ limits: { cpu: "1000m", memory: "1024Mi" } }, { limits: { cpu: "1", memory: "1Gi" } })).toBe(true);
    expect(sameResources({ limits: { cpu: "2" } }, { limits: { cpu: "1" } })).toBe(false);
    expect(sameResources(undefined, undefined)).toBe(true);
    expect(sameResources({ limits: { cpu: "1" } }, undefined)).toBe(false);
  });
});

describe("k8sProvisioner.pendingRestart", () => {
  it("is undefined when the image is current and the pod runs the recorded size", async () => {
    const { kc } = fakeCluster({ image: "sandbox-os:new", mode: "Running", resources: small, pod: { resources: small } });
    expect(await provisioner(kc).pendingRestart(ref)).toBeUndefined();
  });

  it("reports a stale image with both refs", async () => {
    const { kc } = fakeCluster({ image: "sandbox-os:old", mode: "Running", resources: small, pod: { resources: small } });
    expect(await provisioner(kc).pendingRestart(ref)).toEqual({ image: { from: "sandbox-os:old", to: "sandbox-os:new" } });
  });

  it("reports a recorded size the running pod lacks", async () => {
    const { kc } = fakeCluster({ image: "sandbox-os:new", mode: "Running", resources: big, pod: { resources: small } });
    expect(await provisioner(kc).pendingRestart(ref)).toEqual({ size: true });
  });

  it("does not report size for a suspended sandbox, which applies it on its next start anyway", async () => {
    const { kc } = fakeCluster({ image: "sandbox-os:new", mode: "Suspended", resources: big });
    expect(await provisioner(kc).pendingRestart(ref)).toBeUndefined();
  });
});

describe("k8sProvisioner.restart", () => {
  it("cycles a running pod onto the current image and recorded size and waits for it", async () => {
    const cluster = fakeCluster({ image: "sandbox-os:old", mode: "Running", resources: big, pod: { resources: small } });
    const r = await provisioner(cluster.kc).restart(ref);
    expect(r).toEqual({ fromImage: "sandbox-os:old", toImage: "sandbox-os:new", imageCurrent: true, sizeApplied: true, ready: true });
    expect(cluster.modes[0]).toBe("Suspended");
    expect(cluster.modes.at(-1)).toBe("Running");
    expect(cluster.state.pod?.resources).toEqual(big);
    expect(await provisioner(cluster.kc).pendingRestart(ref)).toBeUndefined();
  });

  it("restarts for a size-only change, which the image reconcile alone never cycles for", async () => {
    const cluster = fakeCluster({ image: "sandbox-os:new", mode: "Running", resources: big, pod: { resources: small } });
    const r = await provisioner(cluster.kc).restart(ref);
    expect(r.sizeApplied).toBe(true);
    expect(cluster.modes).toEqual(["Suspended", "Running"]);
    expect(cluster.state.pod?.resources).toEqual(big);
  });
});

describe("k8sProvisioner — image reconcile retry", () => {
  it("retries a transient failure (an apiserver 429) and then adopts the image", async () => {
    const cluster = fakeCluster({ image: "sandbox-os:old", mode: "Suspended" }, { failImagePatches: 2 });
    await provisioner(cluster.kc).resume(ref);
    expect(cluster.imagePatchAttempts()).toBe(3);
    expect(cluster.state.image).toBe("sandbox-os:new");
    expect(cluster.state.mode).toBe("Running");
  });

  it("runs the sandbox as-is after the last try, and pendingRestart still reports the stale image", async () => {
    const cluster = fakeCluster({ image: "sandbox-os:old", mode: "Suspended" }, { failImagePatches: 99 });
    await provisioner(cluster.kc).resume(ref);
    expect(cluster.imagePatchAttempts()).toBe(3);
    expect(cluster.state.mode).toBe("Running");
    expect((await provisioner(cluster.kc).pendingRestart(ref))?.image).toEqual({ from: "sandbox-os:old", to: "sandbox-os:new" });
  });

  it("restart reports imageCurrent=false when every reconcile try fails", async () => {
    const cluster = fakeCluster({ image: "sandbox-os:old", mode: "Running", pod: {} }, { failImagePatches: 99 });
    const r = await provisioner(cluster.kc).restart(ref);
    expect(r.imageCurrent).toBe(false);
    expect(r.ready).toBe(true);
  });
});
