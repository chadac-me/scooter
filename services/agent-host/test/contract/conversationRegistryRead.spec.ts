/**
 * The ConversationRegistry read side. The `Conversation` CR is the source of truth for a
 * conversation's existence, ownership and liveness, so unlike the write side list()
 * throws on a k8s failure (an empty list would make the caller serve blind) while
 * get() maps a 404 to `undefined`.
 */

import { describe, it, expect } from "vitest";

import { noopRegistry } from "../../src/session/conversationRegistry.js";
import { createK8sConversationRegistry } from "../../src/session/k8sConversationRegistry.js";

/** A fake CustomObjectsApi serving `items` for list and a map for get. */
function fakeKc(opts: {
  items?: unknown[];
  listError?: { code?: number };
  getError?: { code?: number };
  byName?: Record<string, unknown>;
} = {}) {
  const api = {
    listNamespacedCustomObject: async () => {
      if (opts.listError) throw Object.assign(new Error("k8s"), opts.listError);
      return { items: opts.items ?? [] };
    },
    getNamespacedCustomObject: async (args: { name: string }) => {
      if (opts.getError) throw Object.assign(new Error("k8s"), opts.getError);
      const hit = (opts.byName ?? {})[args.name];
      if (!hit) throw Object.assign(new Error("not found"), { code: 404 });
      return hit;
    },
  };
  return { kc: { makeApiClient: () => api as never } as never };
}

const cr = (name: string, spec: Record<string, unknown> = {}, status?: Record<string, unknown>) => ({
  metadata: { name },
  spec,
  ...(status ? { status } : {}),
});

describe("ConversationRegistry.list", () => {
  it("returns every CR with spec + status folded into one record", async () => {
    const { kc } = fakeKc({
      items: [cr("conv-a", { owner: "alice", sandboxRef: "conv-xyz", model: "m" },
                 { phase: "Assigned", hostPod: "pod-1", hostIP: "10.0.0.1", generation: 3 })],
    });
    const reg = createK8sConversationRegistry("ns", kc);
    const [rec] = await reg.list();
    expect(rec.id).toBe("conv-a");
    expect(rec.spec.owner).toBe("alice");
    expect(rec.spec.sandboxRef).toBe("conv-xyz");
    expect(rec.phase).toBe("Assigned");
    expect(rec.hostPod).toBe("pod-1");
    expect(rec.generation).toBe(3);
  });

  it("handles a CR the controller has NOT reconciled yet (status absent)", async () => {
    // A freshly-registered CR has `status: null` until the controller's first pass.
    const { kc } = fakeKc({ items: [cr("conv-new", { owner: "bob" })] });
    const [rec] = await createK8sConversationRegistry("ns", kc).list();
    expect(rec.id).toBe("conv-new");
    expect(rec.phase).toBeUndefined();
    expect(rec.hostPod).toBeUndefined();
  });

  it("THROWS on a k8s failure — never a silent empty list", async () => {
    const { kc } = fakeKc({ listError: { code: 503 } });
    await expect(createK8sConversationRegistry("ns", kc).list()).rejects.toThrow();
  });

  it("returns [] for an empty namespace (a real answer, not a failure)", async () => {
    const { kc } = fakeKc({ items: [] });
    await expect(createK8sConversationRegistry("ns", kc).list()).resolves.toEqual([]);
  });

  it("skips a malformed object with no name rather than failing the whole list", async () => {
    const { kc } = fakeKc({ items: [{ spec: {} }, cr("conv-ok")] });
    const out = await createK8sConversationRegistry("ns", kc).list();
    expect(out.map((r) => r.id)).toEqual(["conv-ok"]);
  });
});

describe("ConversationRegistry.get", () => {
  it("returns the record when it exists", async () => {
    const { kc } = fakeKc({ byName: { "conv-a": cr("conv-a", { owner: "alice" }, { phase: "Suspended" }) } });
    const rec = await createK8sConversationRegistry("ns", kc).get("conv-a");
    expect(rec?.phase).toBe("Suspended");
    expect(rec?.spec.owner).toBe("alice");
  });

  it("returns undefined for a missing CR (404 is an answer, not an error)", async () => {
    const { kc } = fakeKc({ byName: {} });
    await expect(createK8sConversationRegistry("ns", kc).get("nope")).resolves.toBeUndefined();
  });

  it("THROWS on a non-404 failure (a blip must not read as 'does not exist')", async () => {
    const { kc } = fakeKc({ getError: { code: 500 } });
    await expect(createK8sConversationRegistry("ns", kc).get("conv-a")).rejects.toThrow();
  });
});

describe("noopRegistry (single-replica)", () => {
  it("list() is [] — single-replica has no CRs, so CR-driven hydrate is a no-op", async () => {
    await expect(noopRegistry.list()).resolves.toEqual([]);
  });

  it("get() is undefined", async () => {
    await expect(noopRegistry.get("anything")).resolves.toBeUndefined();
  });
});
