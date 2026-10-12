/**
 * The file store's failure surface: a failed durable append fires onAppendError and
 * still rejects, and reads distinguish a missing log or state dir (empty) from a
 * real read failure (throws).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { SessionId } from "../../src/types.js";
import type { AguiEvent } from "../../src/bridge.js";

const event: AguiEvent = { type: "RUN_STARTED", threadId: "t", runId: "r" };

describe("fileStore persistence-error surface", () => {
  it("onAppendError fires when a durable append fails (not silently dropped)", async () => {
    const root = mkdtempSync(join(tmpdir(), "store-perr-"));
    try {
      const id = "conv-x" as SessionId;
      // A file at the conversation's directory path makes ensureDir's mkdir fail, standing in for an unwritable volume.
      writeFileSync(join(root, "conv-x"), "i am a file, not a dir", "utf8");

      const store = createFileConversationStore(root);
      const errors: Array<{ id: SessionId; error: unknown }> = [];
      store.onAppendError?.((eid, error) => errors.push({ id: eid, error }));

      // Fire-and-forget, as the manager does.
      const p = store.appendEvent(id, event);
      await p.catch(() => {});

      expect(errors.length).toBe(1);
      expect(errors[0].id).toBe(id);
      expect(errors[0].error).toBeInstanceOf(Error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the returned promise still rejects so awaiting callers see the failure too", async () => {
    const root = mkdtempSync(join(tmpdir(), "store-perr2-"));
    try {
      writeFileSync(join(root, "conv-y"), "file", "utf8");
      const store = createFileConversationStore(root);
      await expect(store.appendEvent("conv-y" as SessionId, event)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readEvents yields empty for a missing log (ENOENT), not an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "store-re-"));
    try {
      const store = createFileConversationStore(root);
      const out = [];
      for await (const e of store.readEvents("nope" as SessionId)) out.push(e);
      expect(out).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readEvents THROWS on a non-ENOENT read error (real log unreadable)", async () => {
    const root = mkdtempSync(join(tmpdir(), "store-re2-"));
    try {
      // A directory at the events.jsonl path makes readFile fail with EISDIR.
      const id = "conv-z";
      mkdirSync(join(root, id, "events.jsonl"), { recursive: true });
      const store = createFileConversationStore(root);
      await expect(async () => {
        for await (const _ of store.readEvents(id as SessionId)) { /* drain */ }
      }).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("listConversations returns [] for a missing state dir (ENOENT)", async () => {
    const root = join(tmpdir(), `store-lc-${process.pid}-${Math.random().toString(36).slice(2)}`);
    // The root deliberately does not exist.
    const store = createFileConversationStore(root);
    expect(await store.listConversations?.()).toEqual([]);
  });

  it("listConversations THROWS when the state path is not a directory (real error)", async () => {
    const root = mkdtempSync(join(tmpdir(), "store-lc2-"));
    try {
      // A file as the store root makes readdir fail with ENOTDIR.
      const fileRoot = join(root, "not-a-dir");
      writeFileSync(fileRoot, "x", "utf8");
      const store = createFileConversationStore(fileRoot);
      await expect(store.listConversations?.()).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
