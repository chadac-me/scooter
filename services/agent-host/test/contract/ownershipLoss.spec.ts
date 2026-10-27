/**
 * Losing a conversation must stop this pod's run, not just fence its writes: the old owner
 * cancels (killing sandbox execs) and drops its bridge, and the new owner resumes a run
 * another pod started only after a hand-off grace.
 */

import { describe, it, expect, vi } from "vitest";

import { createSessionManager } from "../../src/session/manager.js";
import type { ConversationStore, SessionId } from "../../src/session/manager.js";
import { OwnershipTracker } from "../../src/session/ownershipGuard.js";
import type { AguiEvent } from "../../src/bridge.js";

const fakeProvisioner = () =>
  ({
    create: vi.fn(async (short: string) => ({ name: `conv-${short}`, namespace: "ns" })),
    ensure: vi.fn(async (short: string) => ({ name: `conv-${short}`, namespace: "ns" })),
    resume: vi.fn(async (ref: unknown) => ref),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  }) as never;

const memStore = (seed: AguiEvent[] = []) => {
  const logs = new Map<string, AguiEvent[]>([["t1", [...seed]]]);
  return {
    store: {
      appendEvent: async (cid: string, e: AguiEvent) => {
        (logs.get(cid) ?? logs.set(cid, []).get(cid)!).push(e);
      },
      async *readEvents(cid: string) {
        yield* logs.get(cid) ?? [];
      },
      gooseStatePath: (cid: string) => `/state/${cid}/goose`,
    } as never as ConversationStore,
    dump: () => logs.get("t1") ?? [],
  };
};

const fakeBridge = () => ({
  sessionId: "t1",
  start: vi.fn(async () => {}),
  prompt: vi.fn(async () => "run" as never),
  cancel: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  queueState: () => ({ running: true, currentRunMs: 1, queued: 0, maxQueuedPriority: 0 }),
  drainQueue: () => [],
  onPersist: () => () => {},
  onEvent: () => () => {},
  onTitle: () => () => {},
});

describe("relinquish — the old owner stops its run", () => {
  const setup = async () => {
    const guard = new OwnershipTracker("old-pod");
    guard.observe("t1", { hostPod: "old-pod", generation: 5 });
    const bridge = fakeBridge();
    const { store } = memStore();
    const provisioner = fakeProvisioner() as unknown as { suspend: ReturnType<typeof vi.fn> };
    const sessions = createSessionManager({
      provisioner,
      store,
      selfPod: "old-pod",
      ownershipGuard: guard,
      bridgeFactory: () => bridge as never,
    } as never);
    const conv = await sessions.start("t1" as never);
    return { guard, bridge, sessions, provisioner, id: conv.id as SessionId };
  };

  it("cancels (killing execs) and stops the bridge once the row names another pod @proves", async () => {
    const { guard, bridge, sessions, id } = await setup();
    expect(sessions.get(id)?.bridge).toBeDefined();
    guard.observe("t1", { hostPod: "new-pod", generation: 6 });

    await sessions.relinquish(id);

    expect(bridge.cancel).toHaveBeenCalledTimes(1);
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(sessions.get(id)?.bridge, "no new prompt may reach the dead bridge").toBeUndefined();
    expect(sessions.get(id)?.status).toBe("suspended");
  });

  it("leaves the Sandbox running for the new owner", async () => {
    const { guard, sessions, provisioner, id } = await setup();
    guard.observe("t1", { hostPod: "new-pod", generation: 6 });
    await sessions.relinquish(id);
    expect(provisioner.suspend).not.toHaveBeenCalled();
  });

  it("is a no-op when ownership came back before it ran", async () => {
    const { guard, bridge, sessions, id } = await setup();
    guard.observe("t1", { hostPod: "new-pod", generation: 6 });
    guard.observe("t1", { hostPod: "old-pod", generation: 7 });

    await sessions.relinquish(id);

    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(sessions.get(id)?.bridge).toBeDefined();
  });
});

describe("reconcileDanglingRun — hand-off grace before resuming another pod's run", () => {
  const FOREIGN_RUN: AguiEvent[] = [
    { type: "RUN_STARTED", threadId: "t1", runId: "r1", host: "old-pod", gen: 5 },
    { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "run: nix develop -c just db-generate" },
  ] as never;

  const setup = (graceMs: number) => {
    const guard = new OwnershipTracker("new-pod");
    guard.observe("t1", { hostPod: "new-pod", generation: 6 });
    const bridge = fakeBridge();
    const { store } = memStore(FOREIGN_RUN);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      ownershipGuard: guard,
      handoffGraceMs: graceMs,
      bridgeFactory: () => bridge as never,
    } as never);
    return { guard, bridge, sessions };
  };

  it("waits out the grace, then resumes exactly once @proves", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, sessions } = setup(5_000);
      const conv = await sessions.start("t1" as never);
      const done = sessions.reconcileDanglingRun(conv.id as SessionId, 6);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(bridge.prompt, "the old pod may still be executing it").not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await done;
      await vi.runAllTimersAsync();
      expect(bridge.prompt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resume when this pod lost the conversation during the grace", async () => {
    vi.useFakeTimers();
    try {
      const { guard, bridge, sessions } = setup(5_000);
      const conv = await sessions.start("t1" as never);
      const done = sessions.reconcileDanglingRun(conv.id as SessionId, 6);
      guard.observe("t1", { hostPod: "third-pod", generation: 7 });
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(bridge.prompt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
