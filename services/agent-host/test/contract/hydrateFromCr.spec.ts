/**
 * Contract tests for hydrate() driven by the Conversation CR, the source of truth.
 * LOCAL_STATE_PATH is an emptyDir that a restart wipes, so every test here gives the
 * second manager an empty local store and expects the CR list to populate it.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createSessionManager,
  type SandboxProvisioner,
  type ConversationStore,
} from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";
import type { ConversationRecord } from "../../src/session/conversationRegistry.js";

const SELF = "agent-host-abc";

const fakeProvisioner = (): SandboxProvisioner => {
  const refs = new Map<string, SandboxRef>();
  return {
    create: vi.fn(async (id) => {
      const ref = { name: `conv-${id}`, namespace: "ns" };
      refs.set(id, ref);
      return ref;
    }),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async (ref) => ref),
    destroy: vi.fn(async () => {}),
  };
};

/** In-memory store with meta persistence, so "the local cache survived" is expressible. */
const inMemoryStore = (): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  const metas = new Map<string, Record<string, unknown>>();
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
    saveMeta: async (m: { id: string }) => {
      metas.set(m.id, m as Record<string, unknown>);
    },
    listConversations: async () => [...metas.values()],
  } as ConversationStore;
};

/** A registry serving `records` as the CR list. */
const registryWith = (records: ConversationRecord[], opts: { listError?: Error } = {}) => ({
  register: vi.fn(async () => {}),
  setPhase: vi.fn(async () => {}),
  list: vi.fn(async () => {
    if (opts.listError) throw opts.listError;
    return records;
  }),
  get: vi.fn(async (id: string) => records.find((r) => r.id === id)),
});

const cr = (id: string, over: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id,
  spec: { owner: "alice", sandboxRef: `conv-${id}` },
  phase: "Assigned",
  hostPod: SELF,
  generation: 1,
  ...over,
});

/** A provisioner reporting `names` as still-running Sandboxes in the cluster. */
const provisionerWithLive = (names: string[]) => {
  const p = fakeProvisioner();
  p.reconcile = vi.fn(async () => names.map((n) => ({ ref: { name: n, namespace: "ns" }, running: true })));
  return p;
};

describe("hydrate() adopts from the Conversation CR", () => {
  it("THE REGRESSION: an EMPTY local store still adopts a CR whose Sandbox is running", async () => {
    // The pod restarts with local state wiped while the CR and the Sandbox both survive.
    const prov = provisionerWithLive(["conv-gamma"]);
    const registry = registryWith([cr("gamma")]);
    const sessions = createSessionManager({
      provisioner: prov,
      store: inMemoryStore(),
      conversationRegistry: registry as never,
      selfPod: SELF,
    } as never);

    await sessions.hydrate();

    expect(sessions.list(), "the CR is the source of truth; local was empty").toHaveLength(1);
    expect(sessions.get("gamma")?.status).toBe("running");

    // The sweep can therefore reclaim it.
    const swept = await sessions.sweepIdle(0);
    expect(swept).toContain("gamma");
    expect(prov.suspend).toHaveBeenCalledOnce();
  });

  it("does NOT adopt a conversation assigned to ANOTHER pod (I6: one owner)", async () => {
    const prov = provisionerWithLive(["conv-other"]);
    const registry = registryWith([cr("other", { hostPod: "agent-host-somebody-else" })]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    expect(sessions.list()).toHaveLength(0);
    // It must not be swept out from under its real owner.
    expect(await sessions.sweepIdle(0)).toEqual([]);
    expect(prov.suspend).not.toHaveBeenCalled();
  });

  it("does NOT adopt an UNASSIGNED CR — the controller is the single assigner (decision Q1)", async () => {
    // hostPod unset means the controller has not placed it yet, and self-assigning would race its load accounting.
    const prov = provisionerWithLive(["conv-pending"]);
    const registry = registryWith([cr("pending", { hostPod: undefined, phase: undefined })]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    expect(sessions.list()).toHaveLength(0);
  });

  it("adopts a CR with NO local meta and NO history — enough to SUSPEND it (I5)", async () => {
    // suspend() throws for anything not in `entries`, so the adopted CR needs a synthesized entry.
    const prov = provisionerWithLive(["conv-bare"]);
    const registry = registryWith([cr("bare")]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    await expect(sessions.suspend("bare")).resolves.not.toThrow();
    expect(prov.suspend).toHaveBeenCalledOnce();
  });

  it("a CR whose Sandbox is NOT running hydrates as suspended (not a phantom live pod)", async () => {
    const prov = provisionerWithLive([]);
    const registry = registryWith([cr("sleepy", { phase: "Suspended" })]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    expect(sessions.get("sleepy")?.status).toBe("suspended");
    // sweepIdle only suspends running conversations.
    expect(await sessions.sweepIdle(0)).toEqual([]);
    expect(prov.suspend).not.toHaveBeenCalled();
  });

  it("carries the CR's spec onto the adopted entry (owner survives the restart)", async () => {
    const prov = provisionerWithLive(["conv-owned"]);
    const registry = registryWith([cr("owned", { spec: { owner: "bob", sandboxRef: "conv-owned", model: "m1" } })]);
    const sessions = createSessionManager({
      provisioner: prov, store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await sessions.hydrate();
    const c = sessions.get("owned");
    expect(c?.owner).toBe("bob");
    expect(c?.model).toBe("m1");
  });

  it("a LOCAL meta with no CR still hydrates (self-heal, never lose a conversation)", async () => {
    // A conversation created while the CR write failed must keep working and get re-registered.
    const root = inMemoryStore();
    const prov1 = fakeProvisioner();
    const reg1 = registryWith([]);
    const m1 = createSessionManager({
      provisioner: prov1, store: root, conversationRegistry: reg1 as never, selfPod: SELF,
    } as never);
    await m1.start("orphan-local");

    // Same store, still no CR for it.
    const reg2 = registryWith([]);
    const m2 = createSessionManager({
      provisioner: provisionerWithLive([]), store: root,
      conversationRegistry: reg2 as never, selfPod: SELF,
    } as never);
    await m2.hydrate();
    expect(m2.list().map((c) => c.id)).toContain("orphan-local");
    expect(reg2.register, "the authority self-heals toward completeness").toHaveBeenCalled();
  });

  it("PROPAGATES a CR list failure — a pod that cannot read the truth must not serve (Q4)", async () => {
    // Returning [] would be indistinguishable from owning nothing, so the pod would serve blind.
    const registry = registryWith([], { listError: new Error("apiserver unavailable") });
    const sessions = createSessionManager({
      provisioner: provisionerWithLive([]), store: inMemoryStore(),
      conversationRegistry: registry as never, selfPod: SELF,
    } as never);

    await expect(sessions.hydrate()).rejects.toThrow(/apiserver|list/i);
  });

  it("single-replica (noop registry, no selfPod) still hydrates from the local store", async () => {
    // No CRs exist in single-replica, so the local store must remain the path there.
    const root = inMemoryStore();
    const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: root });
    await m1.start("solo");

    const m2 = createSessionManager({ provisioner: provisionerWithLive([]), store: root });
    await m2.hydrate();
    expect(m2.list().map((c) => c.id)).toContain("solo");
  });
});

describe("refreshSandbox() un-freezes a hydrated snapshot", () => {
  it("a placeholder hydrated while the Sandbox was mid-create picks up the real ref once it exists", async () => {
    // Read-path hydration (the UI's first poll) can land before provisioning finishes, freezing a
    // namespace-less placeholder and "suspended" on a pod that is about to run.
    const live: string[] = [];
    const prov = fakeProvisioner();
    prov.reconcile = vi.fn(async () => live.map((n) => ({ ref: { name: n, namespace: "ns" }, running: true })));
    const sessions = createSessionManager({
      provisioner: prov,
      store: inMemoryStore(),
      conversationRegistry: registryWith([cr("delta")]) as never,
      selfPod: SELF,
    } as never);
    expect(await sessions.ensureReadable("delta" as SessionId)).toBe(true);
    const before = sessions.get("delta" as SessionId)!;
    expect(before.status).toBe("suspended");
    expect(before.sandbox.namespace).toBe("");

    live.push(before.sandbox.name);
    await sessions.refreshSandbox!("delta" as SessionId);
    const after = sessions.get("delta" as SessionId)!;
    expect(after.status).toBe("running");
    expect(after.sandbox).toEqual({ name: before.sandbox.name, namespace: "ns" });
  });

  it("is throttled, and leaves the placeholder alone while the Sandbox is still absent", async () => {
    const prov = provisionerWithLive([]);
    const sessions = createSessionManager({
      provisioner: prov,
      store: inMemoryStore(),
      conversationRegistry: registryWith([cr("eps")]) as never,
      selfPod: SELF,
    } as never);
    await sessions.ensureReadable("eps" as SessionId);
    const calls = (prov.reconcile as ReturnType<typeof vi.fn>).mock.calls.length;
    await sessions.refreshSandbox!("eps" as SessionId);
    await sessions.refreshSandbox!("eps" as SessionId);
    expect((prov.reconcile as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls + 1);
    expect(sessions.get("eps" as SessionId)!.sandbox.namespace).toBe("");
  });
});
