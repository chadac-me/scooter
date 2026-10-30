/** Provisioner side of the warm pool: reserve, release, never fail. */

import { describe, it, expect, vi } from "vitest";

import { createK8sProvisioner, sandboxManifest, RELEASE_LABEL } from "../../src/session/k8sProvisioner.js";
import { createWarmStoreReserver, type ReserveFn } from "../../src/session/warmStore.js";

type Call = [string, ...unknown[]];

function fakeKc(o: { running?: boolean; overlay?: boolean; labelError?: number; exists?: boolean } = {}) {
  const calls: Call[] = [];
  const api = {
    createNamespacedServiceAccount: async () => ({}),
    readNamespacedConfigMap: async () => {
      throw Object.assign(new Error("nf"), { code: 404 });
    },
    getNamespacedCustomObject: async () => ({
      spec: {
        operatingMode: o.running ? "Running" : "Suspended",
        podTemplate: { spec: { containers: [{ image: "reg/img:t1" }] } },
        volumeClaimTemplates: [{ metadata: { name: "workspace" } }, ...(o.overlay === false ? [] : [{ metadata: { name: "scooter-rw" } }])],
      },
    }),
    createNamespacedCustomObject: async (p: { body: unknown }) => {
      calls.push(["create", p.body]);
      if (o.exists) throw Object.assign(new Error("exists"), { code: 409 });
      return {};
    },
    patchNamespacedCustomObject: async (p: { body: unknown }) => {
      calls.push(["patch:sandbox", JSON.stringify(p.body)]);
      return {};
    },
    patchNamespacedPersistentVolumeClaim: async (p: { name: string; body: { metadata: { labels: Record<string, unknown> } } }) => {
      calls.push(["label", p.name, p.body.metadata.labels[RELEASE_LABEL]]);
      if (o.labelError) throw Object.assign(new Error("api"), { code: o.labelError });
      return {};
    },
    listNamespacedPod: async () => ({ items: [] }),
    readNamespacedPod: async () => undefined,
  };
  return { kc: { makeApiClient: () => api as never } as never, calls };
}

function setup(o: Parameters<typeof fakeKc>[0] = {}, reserve?: ReserveFn) {
  const { kc, calls } = fakeKc(o);
  const reserveFn: ReserveFn =
    reserve ??
    (async (sandbox, tag) => {
      calls.push(["reserve", sandbox, tag]);
      return { pv: "pv1", pool: "warm", reason: "warm" };
    });
  const p = createK8sProvisioner({
    namespace: "ns",
    sandboxImage: "reg/img:t1",
    overlayStore: true,
    kubeConfig: kc,
    reconcileRetryDelaysMs: [],
    warmStore: { reserve: reserveFn, storageClass: "warm-store-retain" },
  });
  return { p, calls };
}

const names = (calls: Call[]) => calls.map((c) => (c[0] === "patch:sandbox" && String(c[1]).includes("operatingMode") ? "mode" : c[0]));

describe("warm overlay pool: reserve before the pod exists", () => {
  it("create reserves for the new Sandbox's tag before creating it", async () => {
    const { p, calls } = setup();
    await p.create("abc");
    expect(calls.find((c) => c[0] === "reserve")).toEqual(["reserve", "conv-abc", "t1"]);
    expect(names(calls).indexOf("reserve")).toBeLessThan(names(calls).indexOf("create"));
  });

  it("resume clears a pending release and reserves before setting Running", async () => {
    const { p, calls } = setup();
    await p.resume({ name: "conv-abc", namespace: "ns" });
    const order = names(calls).filter((n) => ["label", "reserve", "mode"].includes(n));
    expect(order).toEqual(["label", "reserve", "mode"]);
    expect(calls.find((c) => c[0] === "label")).toEqual(["label", "scooter-rw-conv-abc", null]);
  });

  it("does not reserve for a sandbox that is already running", async () => {
    const { p, calls } = setup({ running: true });
    await p.resume({ name: "conv-abc", namespace: "ns" });
    expect(names(calls)).not.toContain("reserve");
  });

  it("does not reserve for a Sandbox without an overlay claim", async () => {
    const { p, calls } = setup({ overlay: false });
    await p.resume({ name: "conv-abc", namespace: "ns" });
    expect(names(calls)).not.toContain("reserve");
  });

  it("a failed reservation still starts the sandbox", async () => {
    const { p, calls } = setup({}, async () => undefined);
    await p.resume({ name: "conv-abc", namespace: "ns" });
    expect(names(calls)).toContain("mode");
  });

  it("a missing overlay PVC does not stop the reservation", async () => {
    const { p, calls } = setup({ labelError: 404 });
    await p.resume({ name: "conv-abc", namespace: "ns" });
    expect(names(calls)).toContain("reserve");
  });
});

describe("warm overlay pool: release on suspend", () => {
  it("marks the overlay PVC for release after suspending", async () => {
    const { p, calls } = setup();
    await p.suspend({ name: "conv-abc", namespace: "ns" });
    expect(names(calls)).toEqual(["mode", "label"]);
    expect(calls[1]).toEqual(["label", "scooter-rw-conv-abc", "requested"]);
  });

  it("a failed label does not fail the suspend", async () => {
    const { p } = setup({ labelError: 500 });
    await expect(p.suspend({ name: "conv-abc", namespace: "ns" })).resolves.toBeUndefined();
  });

  it("without a warm store, suspend leaves the PVC alone", async () => {
    const { kc, calls } = fakeKc();
    await createK8sProvisioner({ namespace: "ns", sandboxImage: "img", kubeConfig: kc }).suspend({ name: "conv-abc", namespace: "ns" });
    expect(names(calls)).toEqual(["mode"]);
  });
});

describe("overlay PVC storage class", () => {
  type M = { spec: { volumeClaimTemplates: Array<{ metadata: { name: string }; spec: { storageClassName?: string } }> } };
  const vct = (deploy: Record<string, unknown>) =>
    (sandboxManifest("abc", "conv-abc", "sa", "img:t", "ns", "aud", "10Gi", true, { overlayStore: true, ...deploy }) as M).spec
      .volumeClaimTemplates;

  it("puts only the overlay claim on the pool class", () => {
    const t = vct({ overlayStorageClass: "warm-store-retain" });
    expect(t.find((v) => v.metadata.name === "scooter-rw")?.spec.storageClassName).toBe("warm-store-retain");
    expect(t.find((v) => v.metadata.name === "workspace")?.spec.storageClassName).toBeUndefined();
  });

  it("leaves the default class without a warm store", () => {
    expect(vct({}).find((v) => v.metadata.name === "scooter-rw")?.spec.storageClassName).toBeUndefined();
  });

  it("puts only the workspace claim on the workspace class", () => {
    const t = vct({ workspaceStorageClass: "gp3-crun" });
    expect(t.find((v) => v.metadata.name === "workspace")?.spec.storageClassName).toBe("gp3-crun");
    expect(t.find((v) => v.metadata.name === "scooter-rw")?.spec.storageClassName).toBeUndefined();
  });

  it("keeps each claim on its own class when both are set", () => {
    const t = vct({ workspaceStorageClass: "gp3-crun", overlayStorageClass: "warm-store-retain" });
    expect(t.find((v) => v.metadata.name === "workspace")?.spec.storageClassName).toBe("gp3-crun");
    expect(t.find((v) => v.metadata.name === "scooter-rw")?.spec.storageClassName).toBe("warm-store-retain");
  });
});

describe("createWarmStoreReserver", () => {
  it("posts the sandbox and tag with the bearer token", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ pv: "pv1", pool: "warm", reason: "warm" })));
    const reserve = createWarmStoreReserver({ url: "http://ws:8080/", fetch: fetch as never });
    expect(await reserve("conv-a", "t1")).toEqual({ pv: "pv1", pool: "warm", reason: "warm" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://ws:8080/reserve");
    expect(JSON.parse(String(init.body))).toEqual({ sandbox: "conv-a", tag: "t1" });
  });

  it("resolves undefined on an error status, a network error or a timeout", async () => {
    const bad = createWarmStoreReserver({ url: "http://ws", fetch: (async () => new Response("", { status: 503 })) as never });
    expect(await bad("conv-a", "t")).toBeUndefined();
    const down = createWarmStoreReserver({ url: "http://ws", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as never });
    expect(await down("conv-a", "t")).toBeUndefined();
    const slow = createWarmStoreReserver({
      url: "http://ws",
      timeoutMs: 20,
      fetch: ((_u: string, init: RequestInit) =>
        new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as never,
    });
    expect(await slow("conv-a", "t")).toBeUndefined();
  });
});
