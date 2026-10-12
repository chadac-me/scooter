/**
 * The controller's revive push can arrive before the new pod's CR watch delivers the
 * assignment. A push whose generation is newer than anything the watch has shown means
 * the cache is stale, so the pod adopts the assignment and proceeds; a push at or below
 * the observed generation is the stale one and stays fenced.
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
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  }) as never;

const seededStore = (id: string, events: AguiEvent[]) => {
  const logs = new Map<string, AguiEvent[]>([[id, [...events]]]);
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
    dump: () => logs.get(id) ?? [],
  };
};

/** A run the dead pod never finished plus the user's Stop marker, so a correct revive appends a terminal. */
const DEAD_HOST_RUN: AguiEvent[] = [
  { type: "RUN_STARTED", threadId: "t1", runId: "r1", host: "dead-pod", gen: 1 },
  { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "run: sleep 20" },
  { type: "CANCEL_REQUESTED", threadId: "t1", runId: "r1" },
] as never;

describe("reviveFromMirror vs a lagging ownership watch", () => {
  it("a push NEWER than the cached view is honored, not fenced (stale cache ≠ stale push) @proves", async () => {
    const guard = new OwnershipTracker("new-pod");
    guard.observe("t1", { hostPod: "dead-pod", generation: 1 }); // the watch has not seen gen 2 yet

    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN]);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      ownershipGuard: guard,
      hydrateFromMirror: async () => true,
    } as never);
    const conv = await sessions.start("t1" as never);

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    const tail = dump().at(-1) as { type: string; cancelled?: boolean; runId?: string };
    expect(tail, "the push must get through and terminate the cancelled dangling run").toMatchObject({
      type: "RUN_FINISHED",
      runId: "r1",
      cancelled: true,
    });
    expect(guard.canWrite(conv.id as SessionId), "the adopted assignment must unfence appends").toBe(true);
  });

  it("a push at or below the OBSERVED generation stays fenced (genuinely stale)", async () => {
    const guard = new OwnershipTracker("new-pod");
    guard.observe("t1", { hostPod: "third-pod", generation: 3 }); // the CR has moved on past this push

    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN]);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      ownershipGuard: guard,
      hydrateFromMirror: async () => true,
    } as never);
    const conv = await sessions.start("t1" as never);
    const before = dump().length;

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    expect(dump().length, "a stale push must not touch the log third-pod now drives").toBe(before);
    expect(guard.canWrite(conv.id as SessionId), "the stale push must not steal ownership").toBe(false);
  });
});
