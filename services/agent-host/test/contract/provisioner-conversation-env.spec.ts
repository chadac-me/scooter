/**
 * Resume reconciles the env the provisioner derives from the conversation (CONVERSATION_URL,
 * CONVERSATION_ID, SCOOTER_SERVICES_ORIGIN) the same way it reconciles the image. A Sandbox CR is
 * rendered once, at create, so without this a sandbox created before sandbox origins were turned
 * on never learns its origin, however often it is suspended and resumed.
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

type EnvVar = { name: string; value?: string };
const THREAD = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff";
const IMAGE = "sandbox-os:current";
const ORIGINS = { domain: "sbx.example.com", scheme: "https" };
const ORIGIN = "https://5a515e73.sbx.example.com";
const URL_ENV = { name: "CONVERSATION_URL", value: `https://scooter.example.com/?thread=${THREAD}` };
const OTHER_ENV = [
  { name: "HOME", value: "/workspace" },
  { name: "BROKER_TOKEN_PATH", value: "/var/run/secrets/broker/token" },
];

function fakeKc(env: EnvVar[] | undefined, operatingMode = "Suspended") {
  const patches: Array<Record<string, any>> = [];
  const api = {
    getNamespacedCustomObject: async () => ({
      spec: { operatingMode, podTemplate: { spec: { containers: [{ name: "sandbox", image: IMAGE, env }] } } },
    }),
    patchNamespacedCustomObject: async (args: { body: Record<string, any> }) => {
      patches.push(args.body);
      return {};
    },
    listNamespacedPod: async () => ({ items: [] }),
    deleteNamespacedPod: async () => ({}),
    readNamespacedPod: async () => {
      throw Object.assign(new Error("nf"), { code: 404 });
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, patches };
}

const provisioner = (kc: never, sandboxOrigins: typeof ORIGINS | null = ORIGINS) =>
  createK8sProvisioner({
    namespace: "agent-manager",
    sandboxImage: IMAGE,
    kubeConfig: kc,
    publicUrl: "https://scooter.example.com",
    sandboxOrigins: sandboxOrigins ?? undefined,
  });

const ref = { name: "conv-5a515e73", namespace: "agent-manager" };

/** The sandbox container's env in each template patch. */
const patchedEnvs = (patches: Array<Record<string, any>>): EnvVar[][] =>
  patches.flatMap((b) => (b.spec?.podTemplate?.spec?.containers ?? []).map((c: { env?: EnvVar[] }) => c.env));
const modes = (patches: Array<Record<string, any>>) =>
  patches.map((b) => b.spec?.operatingMode).filter(Boolean);
const byName = (env: EnvVar[]) => Object.fromEntries(env.map((e) => [e.name, e.value]));

describe("k8sProvisioner: resume reconciles the conversation env", () => {
  it("gives a sandbox created before sandbox origins its SCOOTER_SERVICES_ORIGIN, keeping the rest", async () => {
    const { kc, patches } = fakeKc([...OTHER_ENV, URL_ENV, { name: "CONVERSATION_ID", value: THREAD }]);
    await provisioner(kc).resume(ref);

    const [env] = patchedEnvs(patches);
    expect(byName(env)).toEqual({
      HOME: "/workspace",
      BROKER_TOKEN_PATH: "/var/run/secrets/broker/token",
      CONVERSATION_URL: URL_ENV.value,
      CONVERSATION_ID: THREAD,
      SCOOTER_SERVICES_ORIGIN: ORIGIN,
    });
    // The image was current, so the patch carries it unchanged.
    expect(patches[0].spec.podTemplate.spec.containers[0].image).toBe(IMAGE);
    expect(modes(patches)).toEqual(["Running"]);
  });

  it("replaces a running pod without suspending, since env only reaches a new one", async () => {
    const { kc, patches } = fakeKc([...OTHER_ENV, { name: "CONVERSATION_ID", value: THREAD }], "Running");
    await provisioner(kc).resume(ref);
    expect(byName(patchedEnvs(patches)[0]).SCOOTER_SERVICES_ORIGIN).toBe(ORIGIN);
    expect(modes(patches)).toEqual(["Running"]);
  });

  it("leaves an up-to-date sandbox alone, whatever order its env is in", async () => {
    const current = [{ name: "SCOOTER_SERVICES_ORIGIN", value: ORIGIN }, ...OTHER_ENV, { name: "CONVERSATION_ID", value: THREAD }, URL_ENV];
    const { kc, patches } = fakeKc(current);
    await provisioner(kc).resume(ref);
    expect(patchedEnvs(patches)).toEqual([]);
    expect(modes(patches)).toEqual(["Running"]);
  });

  it("drops SCOOTER_SERVICES_ORIGIN once the platform no longer sets one", async () => {
    const { kc, patches } = fakeKc([...OTHER_ENV, URL_ENV, { name: "CONVERSATION_ID", value: THREAD }, { name: "SCOOTER_SERVICES_ORIGIN", value: ORIGIN }]);
    await provisioner(kc, null).resume(ref);
    expect(byName(patchedEnvs(patches)[0])).not.toHaveProperty("SCOOTER_SERVICES_ORIGIN");
  });

  it("does nothing to a sandbox with no CONVERSATION_ID to derive from", async () => {
    const { kc, patches } = fakeKc([...OTHER_ENV]);
    await provisioner(kc).resume(ref);
    expect(patchedEnvs(patches)).toEqual([]);
  });
});
