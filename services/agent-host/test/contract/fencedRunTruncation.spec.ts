/**
 * Ownership moving away mid-run: the event-log fence drops the rest of the in-flight run,
 * including its terminal event. The drop must be logged, and the truncated log must read
 * as dangling to the new owner so resume can recover it.
 */
import { describe, it, expect, vi } from "vitest";

import {
  createSessionManager,
  type SandboxProvisioner,
  type ConversationStore,
} from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";
import { hasDanglingRun } from "../../src/session/danglingRun.js";

const fakeProvisioner = (): SandboxProvisioner => {
  const refs = new Map<string, SandboxRef>();
  return {
    create: vi.fn(async (short: string) => {
      const ref = { name: `sb-${short}`, namespace: "ns" };
      refs.set(short, ref);
      return ref;
    }),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  } as never;
};

const inMemoryStore = (): ConversationStore & { dump(id: SessionId): AguiEvent[] } => {
  const logs = new Map<SessionId, AguiEvent[]>();
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
    dump: (id) => logs.get(id) ?? [],
  } as never;
};

/** A run replayed through the persist channel; `flipAt` is the index at which ownership moves away. */
const RUN: AguiEvent[] = [
  { type: "RUN_STARTED", threadId: "t1", runId: "r1", host: "pod-A" },
  { type: "TEXT_MESSAGE_START", messageId: "m1", role: "user" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "!echo first-marker" },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
  { type: "REASONING_START", messageId: "re1" },
  { type: "REASONING_MESSAGE_START", messageId: "re1" },
  { type: "REASONING_MESSAGE_CONTENT", messageId: "re1", delta: "Planning…" },
  { type: "REASONING_MESSAGE_END", messageId: "re1" },
  { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "run: echo" },
  { type: "TOOL_CALL_END", toolCallId: "c1" },
  { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
] as never;

function harness(flipAt: number) {
  let owned = true;
  let persist: ((e: AguiEvent) => void) | undefined;
  const bridgeFactory = () =>
    ({
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      onEvent: () => () => {},
      onTitle: () => () => {},
      onPersist: (cb: (e: AguiEvent) => void) => {
        persist = cb;
        return () => {};
      },
      prompt: vi.fn(async () => {
        RUN.forEach((e, i) => {
          if (i === flipAt) owned = false;
          persist?.(e);
        });
        return "r1";
      }),
    }) as never;
  const store = inMemoryStore();
  const sessions = createSessionManager({
    provisioner: fakeProvisioner(),
    store,
    bridgeFactory,
    ownershipGuard: { canWrite: () => owned },
  });
  return { sessions, store };
}

const TERMINALS = ["RUN_FINISHED", "RUN_ERROR"];

describe("ownership moving MID-RUN", () => {
  it("the fence drop is LOUD — a truncated run must leave a trace", async () => {
    // warn() routes to console.error.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { sessions } = harness(7);
      const conv = await sessions.start("t1" as never);
      await sessions.prompt(conv.id as SessionId, "!echo first-marker");

      const fenceLines = errSpy.mock.calls.filter((args) =>
        args.some((a) => String(a).includes("ownership fence dropped")),
      );
      expect(fenceLines.length, "dropping a run's tail must be visible in the logs").toBeGreaterThan(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("the truncated log reads as DANGLING to the new owner, so resume can fire", async () => {
    // The new owner sees a RUN_STARTED stamped with the old host and treats the run as stranded.
    const { sessions, store } = harness(7);
    const conv = await sessions.start("t1" as never);
    await sessions.prompt(conv.id as SessionId, "!echo first-marker");

    const events = store.dump(conv.id as SessionId);
    expect(events.map((e) => e.type), "the log is truncated mid-run").not.toContain("RUN_FINISHED");
    expect(
      hasDanglingRun(events, { host: "pod-B" }),
      "the new owner must see this run as stranded",
    ).toBe(true);
  });

  it("control: with stable ownership the same run persists completely", async () => {
    const { sessions, store } = harness(RUN.length + 1);
    const conv = await sessions.start("t1" as never);
    await sessions.prompt(conv.id as SessionId, "!echo first-marker");
    const types = store.dump(conv.id as SessionId).map((e) => e.type);
    expect(types).toContain("RUN_FINISHED");
  });
});

describe("reviveFromMirror give-ups are LOUD", () => {
  it("warns when assigned a conversation it cannot reconstruct", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = inMemoryStore();
      const sessions = createSessionManager({
        provisioner: fakeProvisioner(),
        store,
      });
      await sessions.reviveFromMirror("ghost-conv" as SessionId, 1);

      const warned = errSpy.mock.calls.filter((args) =>
        args.some((a) => String(a).includes("could not reconstruct")),
      );
      expect(warned.length, "an assigned-but-unrevivable conversation must leave a trace").toBeGreaterThan(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});
