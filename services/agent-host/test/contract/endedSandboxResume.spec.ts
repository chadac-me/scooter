/**
 * An exec still polling for its pod when a DELETE lands must not recreate the deleted Sandbox.
 * Seen on the nightly e2e-full: queue-durability's teardown left three conv-* pods recreated by
 * resume-on-missing-pod, each holding a CPU request until the orphan reap ~10 min later, and the
 * next spec's sandbox sat Pending past the 90s ready-pod deadline on the saturated node.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionManager, type SandboxProvisioner, type SandboxRef } from "../../src/session/manager.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
import { resumeUnlessEnded } from "../../src/session/resumeGuard.js";
import { pollForReadyPod } from "../../src/exec/k8sExec.js";
import type { AguiEvent } from "../../src/bridge.js";

const fakeBridge = () => ({
  async start() {},
  async stop() {},
  async prompt() {},
  answerPermission: () => true,
  onEvent(_cb: (e: AguiEvent) => void) {},
  onPersist(_cb: (e: AguiEvent) => void) {
    return () => {};
  },
  onTitle() {},
  queueState: () => ({ running: false, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
});

function harness(root: string) {
  const provisioner: SandboxProvisioner = {
    create: vi.fn(async (id: string) => ({ name: `conv-${id}`, namespace: "ns" })),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async (ref: SandboxRef) => ref),
    destroy: vi.fn(async () => {}),
  };
  const sessions = createSessionManager({
    provisioner,
    store: createFileConversationStore(root) as never,
    bridgeFactory: () => fakeBridge() as never,
  });
  return { provisioner, sessions };
}

describe("resume-on-missing-pod after end()", () => {
  it("does not resume (and so never recreates) the Sandbox of an ended conversation", async () => {
    const root = mkdtempSync(join(tmpdir(), "ended-resume-"));
    try {
      const { provisioner, sessions } = harness(root);
      const conv = await sessions.start("thread-ended-1");
      const ensure = resumeUnlessEnded(sessions, provisioner, conv.id, conv.sandbox);
      await sessions.end(conv.id);

      expect(sessions.isEnded?.(conv.id)).toBe(true);
      await expect(ensure()).rejects.toMatchObject({ code: 404 });
      expect(provisioner.resume).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still resumes a live conversation's idle-suspended Sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "live-resume-"));
    try {
      const { provisioner, sessions } = harness(root);
      const conv = await sessions.start("thread-live-1");
      expect(sessions.isEnded?.(conv.id)).toBe(false);
      await resumeUnlessEnded(sessions, provisioner, conv.id, conv.sandbox)();
      expect(provisioner.resume).toHaveBeenCalledWith(conv.sandbox);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an exec polling for the ended conversation's pod fails fast instead of waiting out the deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "ended-poll-"));
    try {
      const { provisioner, sessions } = harness(root);
      const conv = await sessions.start("thread-ended-2");
      await sessions.end(conv.id);

      const sleep = vi.fn(async () => {});
      await expect(
        pollForReadyPod(conv.sandbox, {
          listCandidates: async () => [],
          ensureRunning: resumeUnlessEnded(sessions, provisioner, conv.id, conv.sandbox),
          sleep,
          deadlineMs: 90_000,
        }),
      ).rejects.toThrow(/is gone/);
      expect(sleep).not.toHaveBeenCalled();
      expect(provisioner.resume).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
