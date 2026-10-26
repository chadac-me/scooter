/** SessionManager stopSandbox and restartSandbox, including mid-run stops. */

import { describe, it, expect, vi } from "vitest";

import { createSessionManager, type SandboxProvisioner, type ConversationStore } from "../../src/session/manager.js";
import type { AguiEvent, SessionBridge } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";

const fakeProvisioner = () =>
  ({
    create: vi.fn(async (id: string) => ({ name: `conv-${id}`, namespace: "ns" })),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async (ref: SandboxRef) => ref),
    destroy: vi.fn(async () => {}),
    pendingRestart: vi.fn(async () => ({ image: { from: "os:old", to: "os:new" } })),
    restart: vi.fn(async () => ({ fromImage: "os:old", toImage: "os:new", imageCurrent: true, sizeApplied: false, ready: true })),
  }) satisfies SandboxProvisioner;

const inMemoryStore = (): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
  };
};

/** Fake bridges with test-controlled run state. */
function controllableBridges() {
  const bridges = new Map<string, { running: boolean; stop: ReturnType<typeof vi.fn>; persist: (e: AguiEvent) => void }>();
  const factory = ({ conversationId }: { conversationId: string }) => {
    const listeners = new Set<(e: AguiEvent) => void>();
    const b = { running: false, stop: vi.fn(async () => {}), persist: (e: AguiEvent) => listeners.forEach((l) => l(e)) };
    bridges.set(conversationId, b);
    return {
      onEvent: () => () => {},
      onPersist: (cb: (e: AguiEvent) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      prompt: async () => {},
      cancel: () => {},
      stop: b.stop,
      start: async () => {},
      queueState: () => ({ running: b.running, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
      answerPermission: () => {},
    } as unknown as SessionBridge;
  };
  /** Ends `id`'s run: clears running, persists RUN_FINISHED. */
  const finishRun = (id: string) => {
    const b = bridges.get(id)!;
    b.running = false;
    b.persist({ type: "RUN_FINISHED", threadId: id, runId: "r1" } as AguiEvent);
  };
  return { factory, bridges, finishRun };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function setup() {
  const provisioner = fakeProvisioner();
  const b = controllableBridges();
  const cycled: SandboxRef[] = [];
  const sessions = createSessionManager({
    provisioner,
    store: inMemoryStore(),
    bridgeFactory: b.factory,
    onSandboxCycled: (ref) => cycled.push(ref),
  });
  return { provisioner, sessions, cycled, ...b };
}

describe("SessionManager.stopSandbox", () => {
  it("with no run in flight, suspends the conversation and reports what the next start picks up", async () => {
    const { provisioner, sessions, cycled } = setup();
    const conv = await sessions.start("t1", undefined, "alice");
    const r = await sessions.stopSandbox!(conv.id);
    expect(r).toEqual({ deferred: false, pending: { image: { from: "os:old", to: "os:new" } } });
    expect(provisioner.suspend).toHaveBeenCalledOnce();
    expect(sessions.get(conv.id)?.status).toBe("suspended");
    expect(cycled).toEqual([conv.sandbox]);
  });

  it("mid-run, stops only the pod and keeps the turn alive, then suspends when the run ends", async () => {
    const { provisioner, sessions, bridges, finishRun, cycled } = setup();
    const conv = await sessions.start("t1", undefined, "alice");
    bridges.get(conv.id)!.running = true;

    const r = await sessions.stopSandbox!(conv.id);
    expect(r.deferred).toBe(true);
    expect(provisioner.suspend).toHaveBeenCalledOnce();
    expect(bridges.get(conv.id)!.stop, "the calling turn's bridge must survive").not.toHaveBeenCalled();
    expect(sessions.get(conv.id)?.status).toBe("running");
    expect(cycled).toEqual([conv.sandbox]);

    finishRun(conv.id);
    await settle();
    expect(sessions.get(conv.id)?.status).toBe("suspended");
    expect(bridges.get(conv.id)!.stop).toHaveBeenCalledOnce();
  });

  it("a sandbox call after a mid-run stop (the exec self-heal) cancels the deferred suspend", async () => {
    const { sessions, bridges, finishRun } = setup();
    const conv = await sessions.start("t1", undefined, "alice");
    bridges.get(conv.id)!.running = true;
    await sessions.stopSandbox!(conv.id);

    sessions.noteSandboxResumed!(conv.id);
    finishRun(conv.id);
    await settle();
    expect(sessions.get(conv.id)?.status).toBe("running");
    expect(bridges.get(conv.id)!.stop).not.toHaveBeenCalled();
  });

  it("from a subagent, stops its root's shared sandbox", async () => {
    const { provisioner, sessions } = setup();
    const parent = await sessions.start("p", undefined, "alice");
    const child = await sessions.spawnChild(parent.id, "c", { prompt: "x" });
    await sessions.stopSandbox!(child.id);
    expect(provisioner.suspend).toHaveBeenCalledWith(parent.sandbox);
    expect(sessions.get(parent.id)?.status).toBe("suspended");
  });

  it("refuses (409) while another conversation's run is using the sandbox", async () => {
    const { provisioner, sessions, bridges } = setup();
    const parent = await sessions.start("p", undefined, "alice");
    const child = await sessions.spawnChild(parent.id, "c", { prompt: "x" });
    bridges.get(child.id)!.running = true;
    await expect(sessions.stopSandbox!(parent.id)).rejects.toMatchObject({ code: 409 });
    expect(provisioner.suspend).not.toHaveBeenCalled();
  });
});

describe("SessionManager.restartSandbox", () => {
  it("restarts from inside the caller's own run, and tells the exec layer to reconnect", async () => {
    const { provisioner, sessions, bridges, cycled } = setup();
    const conv = await sessions.start("t1", undefined, "alice");
    bridges.get(conv.id)!.running = true;
    const r = await sessions.restartSandbox!(conv.id);
    expect(r).toMatchObject({ fromImage: "os:old", toImage: "os:new", ready: true });
    expect(provisioner.restart).toHaveBeenCalledWith(conv.sandbox);
    expect(bridges.get(conv.id)!.stop).not.toHaveBeenCalled();
    expect(cycled).toEqual([conv.sandbox]);
  });

  it("refuses (409) while another conversation's run is using the sandbox", async () => {
    const { provisioner, sessions, bridges } = setup();
    const parent = await sessions.start("p", undefined, "alice");
    const child = await sessions.spawnChild(parent.id, "c", { prompt: "x" });
    bridges.get(parent.id)!.running = true;
    await expect(sessions.restartSandbox!(child.id)).rejects.toMatchObject({ code: 409 });
    expect(provisioner.restart).not.toHaveBeenCalled();
  });

  it("restarting a suspended conversation's sandbox marks it running", async () => {
    const { sessions } = setup();
    const conv = await sessions.start("t1", undefined, "alice");
    await sessions.suspend(conv.id);
    await sessions.restartSandbox!(conv.id);
    expect(sessions.get(conv.id)?.status).toBe("running");
  });
});
