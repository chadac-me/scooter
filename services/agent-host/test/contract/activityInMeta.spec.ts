/**
 * `lastActivityAt` has exactly one home: the conversation record, written by saveMeta.
 * Nothing else persists a competing copy, and a stray copy on a PVC never overrides the
 * record. Asserted through the store API, not the filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { ConversationMeta } from "../../src/session/manager.js";
import type { SessionId } from "../../src/types.js";

const ID = "conv-activity" as SessionId;

const meta = (over: Partial<ConversationMeta> = {}): ConversationMeta =>
  ({
    id: ID,
    threadId: ID,
    title: "A conversation",
    createdAt: 1_000,
    lastActivityAt: 1_000,
    ...over,
  }) as ConversationMeta;

describe("lastActivityAt has one home", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "scooter-activity-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("exposes no second write seam for activity", () => {
    // Without recordActivity a caller cannot write a competing copy even by accident.
    const store = createFileConversationStore(root);
    expect((store as { recordActivity?: unknown }).recordActivity).toBeUndefined();
  });

  it("a stray activity marker is IGNORED, not obeyed", async () => {
    // Strays are inert and reaped by ordinary conversation removal.
    const store = createFileConversationStore(root);
    await store.saveMeta!(meta({ lastActivityAt: 2_000 }));
    await writeFile(
      join(root, ID, "activity.json"),
      JSON.stringify({ lastActivityAt: 999_999 }),
      "utf8",
    );

    expect((await store.listConversations!())[0].lastActivityAt).toBe(2_000);
  });
});
