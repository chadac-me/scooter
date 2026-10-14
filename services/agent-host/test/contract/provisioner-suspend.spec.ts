/**
 * suspend()'s namespace and not-found policy. hydrateEntry() hands out placeholder refs
 * with an empty namespace, which a k8s patch would route at the cluster scope, so
 * suspend() falls back to the provisioner's own namespace; a Sandbox that is already
 * gone counts as suspended, so a 404 is swallowed while any other error propagates.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

/** A fake KubeConfig recording patch calls, optionally rejecting with a k8s-style { code }. */
function fakeKc(opts: { patchRejectCode?: number }) {
  const patchCalls: Array<{ namespace?: string; name?: string }> = [];
  // One stub is returned for every makeApiClient() call.
  const api = {
    patchNamespacedCustomObject: async (params: { namespace?: string; name?: string }) => {
      patchCalls.push({ namespace: params.namespace, name: params.name });
      if (opts.patchRejectCode) throw Object.assign(new Error("api"), { code: opts.patchRejectCode });
      return {};
    },
  };
  const kc = { makeApiClient: () => api as never };
  return { kc: kc as never, patchCalls };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({
    namespace: "agent-manager",
    sandboxImage: "img",
    kubeConfig: kc,
  });

describe("k8sProvisioner.suspend", () => {
  it("patches in the provisioner namespace when the ref namespace is EMPTY (not the cluster scope)", async () => {
    const { kc, patchCalls } = fakeKc({});
    await provisioner(kc).suspend({ name: "conv-abc", namespace: "" });
    expect(patchCalls).toHaveLength(1);
    // An empty namespace is normalized to the provisioner's own.
    expect(patchCalls[0].namespace).toBe("agent-manager");
    expect(patchCalls[0].name).toBe("conv-abc");
  });

  it("keeps a real ref namespace as-is", async () => {
    const { kc, patchCalls } = fakeKc({});
    await provisioner(kc).suspend({ name: "conv-xyz", namespace: "other-ns" });
    expect(patchCalls[0].namespace).toBe("other-ns");
  });

  it("SWALLOWS a 404 (sandbox already gone — nothing to suspend, stop the churn)", async () => {
    const { kc } = fakeKc({ patchRejectCode: 404 });
    await expect(provisioner(kc).suspend({ name: "conv-gone", namespace: "" })).resolves.toBeUndefined();
  });

  it("PROPAGATES a non-404 error (e.g. a genuine 403/500 — do not hide it)", async () => {
    const { kc } = fakeKc({ patchRejectCode: 500 });
    await expect(provisioner(kc).suspend({ name: "conv-x", namespace: "agent-manager" })).rejects.toThrow();
  });
});
