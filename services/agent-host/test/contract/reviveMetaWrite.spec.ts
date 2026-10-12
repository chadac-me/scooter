/**
 * revive() persists the conversation exactly once, awaited, so a persist failure
 * reaches the caller and no fire-and-forget write can outlive the call and surface
 * as an unhandled rejection.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionManager, type SandboxProvisioner } from "../../src/session/manager.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { AguiEvent } from "../../src/bridge.js";

const fakeProvisioner = (): SandboxProvisioner => ({
  create: vi.fn(async (id) => ({ name: `conv-${id}`, namespace: "ns" })),
  suspend: vi.fn(async () => {}),
  resume: vi.fn(async (ref) => ref),
  destroy: vi.fn(async () => {}),
});

function makeFakeBridge() {
  const prompts: string[] = [];
  return {
    started: false,
    prompts,
    async start() {
      this.started = true;
    },
    async stop() {},
    async prompt(text: string) {
      prompts.push(text);
    },
    answerPermission: () => true,
    onEvent(_cb: (e: AguiEvent) => void) {},
    onPersist(_cb: (e: AguiEvent) => void) {
      return () => {};
    },
    onTitle() {},
    queueState: () => ({ running: false, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
  };
}

/** A real manager and file store with saveMeta wrapped to count writes, track in-flight ones and fail on demand. */
function harness(root: string) {
  const base = createFileConversationStore(root);
  const state = { calls: 0, inFlight: 0, fail: false };
  const store = {
    ...base,
    saveMeta: async (m: Parameters<NonNullable<typeof base.saveMeta>>[0]) => {
      state.calls++;
      state.inFlight++;
      try {
        await new Promise((r) => setTimeout(r, 10));
        if (state.fail) throw new Error("saveMeta boom");
        return await base.saveMeta?.(m);
      } finally {
        state.inFlight--;
      }
    },
  };
  const sessions = createSessionManager({
    provisioner: fakeProvisioner(),
    store: store as never,
    bridgeFactory: () => makeFakeBridge() as never,
  });
  return { sessions, state };
}

describe("revive() meta persistence", () => {
  it("leaves NO write in flight once it resolves", async () => {
    const root = mkdtempSync(join(tmpdir(), "revive-meta-inflight-"));
    try {
      const { sessions, state } = harness(root);
      const conv = await sessions.start("thread-meta-1");
      await sessions.suspend(conv.id);

      await sessions.revive(conv.id);

      // A write still running here outlives revive(), with nothing left to catch its rejection.
      expect(state.inFlight, "no durable write may outlive revive()").toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists exactly ONCE — no fire-and-forget write racing the awaited one", async () => {
    const root = mkdtempSync(join(tmpdir(), "revive-meta-count-"));
    try {
      const { sessions, state } = harness(root);
      const conv = await sessions.start("thread-meta-2");
      await sessions.suspend(conv.id);

      state.calls = 0;
      await sessions.revive(conv.id);

      // Two writes means an unawaited write is racing the awaited one.
      expect(state.calls, "revive must issue a single, awaited meta write").toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still records the resume as activity (idle sweep must not re-suspend it)", async () => {
    const root = mkdtempSync(join(tmpdir(), "revive-meta-touch-"));
    try {
      const { sessions } = harness(root);
      const conv = await sessions.start("thread-meta-3");
      const before = sessions.get(conv.id)!.lastActivityAt;
      await sessions.suspend(conv.id);
      await new Promise((r) => setTimeout(r, 5));

      await sessions.revive(conv.id);

      // A stale lastActivityAt lets sweepIdle re-suspend the pod revive() just started.
      expect(
        sessions.get(conv.id)!.lastActivityAt,
        "revive must count as activity or the idle sweep reclaims the fresh pod",
      ).toBeGreaterThan(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a failing persist rejects OUT of revive() instead of becoming an unhandled rejection", async () => {
    const root = mkdtempSync(join(tmpdir(), "revive-meta-fail-"));
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { sessions, state } = harness(root);
      const conv = await sessions.start("thread-meta-4");
      await sessions.suspend(conv.id);

      state.fail = true;
      await expect(sessions.revive(conv.id), "the caller must see the persist failure").rejects.toThrow(
        /saveMeta boom/,
      );
      state.fail = false;

      // Let any orphaned write settle so Node can report it unhandled.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled, "a persist nobody awaits crashes the host on rejection").toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
