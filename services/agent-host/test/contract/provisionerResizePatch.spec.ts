/**
 * A resize is sent as a merge patch: `@kubernetes/client-node` defaults
 * `patchNamespacedCustomObject` to json-patch, which expects an array of ops, so the
 * merge-shaped body must carry the merge-patch content type or the API server 400s.
 */

import { describe, it, expect } from "vitest";
import { PatchStrategy } from "@kubernetes/client-node";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

/** A fake k8s API recording each patch call's body and per-call options. */
function fakeKc(existing = true) {
  const patches: Array<{ body: unknown; opts: unknown }> = [];
  const created: unknown[] = [];
  const api = {
    createNamespacedServiceAccount: async () => ({}),
    createNamespacedCustomObject: async (p: { body?: unknown }) => {
      created.push(p.body);
      return {};
    },
    getNamespacedCustomObject: async () => {
      if (!existing) throw Object.assign(new Error("not found"), { code: 404 });
      return { spec: { podTemplate: { spec: { containers: [{ name: "sandbox", image: "img" }] } } } };
    },
    patchNamespacedCustomObject: async (body: unknown, opts: unknown) => {
      patches.push({ body, opts });
      return {};
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, patches, created };
}

/** The Content-Type the request will carry, recovered by running the options' header middleware against a recording context. */
function contentTypeOf(opts: unknown): string | undefined {
  const mw = (opts as { middleware?: Array<{ pre?: (ctx: unknown) => unknown }> } | undefined)?.middleware?.[0];
  if (!mw?.pre) return undefined;
  let seen: string | undefined;
  mw.pre({
    setHeaderParam: (k: string, v: string) => {
      if (k.toLowerCase() === "content-type") seen = v;
    },
  });
  return seen;
}

const provisioner = (kc: never, sizes?: Record<string, unknown>) =>
  createK8sProvisioner({
    namespace: "agent-sandbox",
    sandboxImage: "img",
    kubeConfig: kc,
    ...(sizes ? { sizePresetsJson: JSON.stringify(sizes) } : {}),
  });

describe("setSize — the patch content type", () => {
  it("sends a MERGE patch, not the client's default json-patch", async () => {
    const { kc, patches } = fakeKc();
    await provisioner(kc).setSize("conv1", { requests: { cpu: "2", memory: "8Gi" }, limits: { cpu: "2", memory: "8Gi" } });

    expect(patches).toHaveLength(1);
    expect(contentTypeOf(patches[0].opts)).toBe(PatchStrategy.MergePatch);
  });

  it("sends a merge-SHAPED body (an object), which is why the header must match", async () => {
    // A json-patch body would be an array of {op, path, value}.
    const { kc, patches } = fakeKc();
    await provisioner(kc).setSize("conv1", { requests: { cpu: "2", memory: "8Gi" }, limits: { cpu: "2", memory: "8Gi" } });

    const body = (patches[0].body as { body: unknown }).body;
    expect(Array.isArray(body)).toBe(false);
    const containers = (body as {
      spec: { podTemplate: { spec: { containers: Array<{ resources?: unknown; name?: string }> } } };
    }).spec.podTemplate.spec.containers;
    expect(containers[0].resources).toEqual({
      requests: { cpu: "2", memory: "8Gi" },
      limits: { cpu: "2", memory: "8Gi" },
    });
    // The merge patch must keep the container's name so it patches rather than replaces it.
    expect(containers[0].name).toBe("sandbox");
  });

  it("applies the same patch for a named preset", async () => {
    const { kc, patches } = fakeKc();
    await provisioner(kc, { big: { cpu: "4", memory: "16Gi" } }).setSize("conv1", { size: "big" });

    expect(contentTypeOf(patches[0].opts)).toBe(PatchStrategy.MergePatch);
    const body = (patches[0].body as { body: unknown }).body as {
      spec: { podTemplate: { spec: { containers: Array<{ resources?: unknown }> } } };
    };
    expect(body.spec.podTemplate.spec.containers[0].resources).toEqual({
      requests: { cpu: "4", memory: "16Gi" },
      limits: { cpu: "4", memory: "16Gi" },
    });
  });

  it("creates the Sandbox cold instead of patching when none exists yet", async () => {
    // A size chosen before the first turn has no CR to patch.
    const { kc, patches, created } = fakeKc(false);
    await provisioner(kc).setSize("conv1", { requests: { cpu: "2", memory: "8Gi" }, limits: { cpu: "2", memory: "8Gi" } });
    expect(patches).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect((created[0] as { spec: { operatingMode: string } }).spec.operatingMode).toBe("Suspended");
  });
});
