/**
 * create() treats a 409 AlreadyExists on the Sandbox as reuse, adopting and resuming
 * the existing one: a prompt for an existing conversation can take the create path
 * after a failed boot hydrate.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

/** A fake k8s API whose Sandbox create can be told to 409, recording whether the provisioner then resumed the existing Sandbox. */
function fakeKc(opts: { sandboxCreate409?: boolean } = {}) {
  const calls: string[] = [];
  const api = {
    createNamespacedServiceAccount: async () => ({}),
    createNamespacedConfigMap: async () => ({}),
    readNamespacedConfigMap: async () => { throw Object.assign(new Error("nf"), { code: 404 }); },
    // create() reads the CR first to keep a cold Sandbox's size, so the fake returns one exactly when the create will 409.
    getNamespacedCustomObject: async () => {
      if (!opts.sandboxCreate409) throw Object.assign(new Error("not found"), { code: 404 });
      return { spec: { podTemplate: { spec: { containers: [{ name: "sandbox", image: "img" }] } } } };
    },
    createNamespacedCustomObject: async () => {
      calls.push("create:sandbox");
      if (opts.sandboxCreate409) throw Object.assign(new Error("exists"), { code: 409 });
      return {};
    },
    patchNamespacedCustomObject: async () => {
      calls.push("patch:mode");
      return {};
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, calls };
}

const provisioner = (kc: never) =>
  createK8sProvisioner({ namespace: "agent-manager", sandboxImage: "img", kubeConfig: kc });

describe("k8sProvisioner.create — 409 AlreadyExists = reuse", () => {
  it("adopts + resumes the existing Sandbox on a 409 (does NOT throw)", async () => {
    const { kc, calls } = fakeKc({ sandboxCreate409: true });
    const ref = await provisioner(kc).create("conv1", "conv1");
    expect(ref.name).toBe("conv-conv1");
    expect(calls).toContain("create:sandbox");
    expect(calls).toContain("patch:mode");
  });

  it("a fresh create (no 409) does NOT resume — operatingMode=Running already", async () => {
    const { kc, calls } = fakeKc({ sandboxCreate409: false });
    const ref = await provisioner(kc).create("conv1", "conv1");
    expect(ref.name).toBe("conv-conv1");
    expect(calls).toContain("create:sandbox");
    expect(calls).not.toContain("patch:mode");
  });

  it("a NON-409 create error still throws (don't mask a real failure as reuse)", async () => {
    const api = {
      createNamespacedServiceAccount: async () => ({}),
      createNamespacedConfigMap: async () => ({}),
      readNamespacedConfigMap: async () => { throw Object.assign(new Error("nf"), { code: 404 }); },
      createNamespacedCustomObject: async () => { throw Object.assign(new Error("boom"), { code: 500 }); },
      patchNamespacedCustomObject: async () => ({}),
    };
    const kc = { makeApiClient: () => api as never } as never;
    await expect(provisioner(kc).create("conv1", "conv1")).rejects.toThrow();
  });
});
