// The pick must travel from promptByThread to the bridge factory.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionManager, type SandboxRef } from "../../src/session/manager.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { AguiEvent } from "../../src/bridge.js";

function makeFakeBridge() {
  return {
    async start() {},
    async stop() {},
    async prompt() {},
    async cancel() {},
    answerPermission: () => true,
    onEvent(_cb: (e: AguiEvent) => void) {},
    onPersist(_cb: (e: AguiEvent) => void) {
      return () => {};
    },
    onTitle() {},
    queueState: () => ({ running: false, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
  };
}

const provisioner = () =>
  ({
    create: vi.fn(async (id: string) => ({ name: `conv-${id}`, namespace: "ns" }) as SandboxRef),
    resume: vi.fn(async (ref: SandboxRef) => ref),
    suspend: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  }) as never;

describe("an explicit provider pick REACHES the bridge", () => {
  it("a provider-only swap rebuilds the bridge WITH the new provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "provider-swap-"));
    try {
      const builds: Array<string | undefined> = [];
      const sessions = createSessionManager({
        provisioner: provisioner(),
        store: createFileConversationStore(root) as never,
        bridgeFactory: ({ pickedProvider }) => {
          builds.push(pickedProvider);
          return makeFakeBridge() as never;
        },
      });

      const conv = await sessions.start("thread-swap-1", "claude-opus-5", "alice");
      builds.length = 0;

      // The swap keeps the same model and changes only the provider.
      await sessions.promptByThread(
        conv.threadId ?? ("thread-swap-1" as never),
        "hi",
        "claude-opus-5",
        undefined,
        "alice",
        undefined,
        undefined,
        undefined,
        "sdk-claude",
      );

      expect(
        builds,
        "a provider-only swap must rebuild the bridge carrying the picked provider",
      ).toContain("sdk-claude");
      await sessions.end(conv.id).catch(() => {});
    } finally {
      // saveMeta is fire-and-forget; let it settle before removing the dir.
      await new Promise((r) => setTimeout(r, 50));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
