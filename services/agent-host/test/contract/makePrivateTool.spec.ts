/**
 * make_conversation_private: an agent may narrow a conversation to its owner, never widen
 * one. The owner-only PATCH /visibility stays the sole way back to shared.
 */

import { describe, it, expect } from "vitest";

import { createSessionManager, type SandboxProvisioner, type ConversationStore } from "../../src/session/manager.js";
import { handleMakeConversationPrivate, type VisibilityToolsWiring } from "../../src/agent/visibilityTools.js";
import type { AguiEvent, SessionBridge } from "../../src/bridge.js";
import type { SessionId } from "../../src/types.js";

const fakeProvisioner = (): SandboxProvisioner => ({
  create: async (id) => ({ name: `conv-${id}`, namespace: "ns" }),
  suspend: async () => {},
  resume: async (ref) => ref,
  destroy: async () => {},
});

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

const idleBridge = () =>
  ({
    onEvent: () => () => {},
    onPersist: () => () => {},
    prompt: async () => {},
    cancel: () => {},
    stop: async () => {},
    start: async () => {},
    queueState: () => ({ running: false, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
    answerPermission: () => {},
  }) as unknown as SessionBridge;

/** A session manager plus the wiring index.ts builds, with memory standing in for the store. */
function setup() {
  const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: idleBridge });
  const wiring: VisibilityToolsWiring = {
    rootOf: (id) => {
      let c = sessions.get(id as SessionId);
      while (c?.parentId) c = sessions.get(c.parentId);
      return c?.id;
    },
    owner: (id) => sessions.get(id as SessionId)?.owner,
    currentVisibility: async (id) => sessions.get(id as SessionId)?.visibility ?? "shared",
    makePrivate: (id) => sessions.setVisibility(id as SessionId, "private"),
  };
  return { sessions, wiring };
}

const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("");

describe("make_conversation_private", () => {
  it("makes an owned shared conversation private", async () => {
    const { sessions, wiring } = setup();
    await sessions.start("t", undefined, "alice");
    const r = await handleMakeConversationPrivate(wiring, "t");
    expect(r.isError).toBeFalsy();
    expect(sessions.get("t" as SessionId)?.visibility).toBe("private");
  });

  it("reports an already-private conversation without erroring", async () => {
    const { sessions, wiring } = setup();
    await sessions.start("t", undefined, "alice", { visibility: "private" });
    const r = await handleMakeConversationPrivate(wiring, "t");
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/already private/);
  });

  it("refuses a conversation with no owner", async () => {
    const { sessions, wiring } = setup();
    await sessions.start("t");
    const r = await handleMakeConversationPrivate(wiring, "t");
    expect(r.isError).toBe(true);
    expect(sessions.get("t" as SessionId)?.visibility ?? "shared").toBe("shared");
  });

  it("from a subagent, makes the root and the subagent private", async () => {
    const { sessions, wiring } = setup();
    const root = await sessions.start("root", undefined, "alice");
    const child = await sessions.spawnChild(root.id, "child", { prompt: "x" });
    const r = await handleMakeConversationPrivate(wiring, child.id);
    expect(r.isError).toBeFalsy();
    expect(sessions.get(root.id)?.visibility).toBe("private");
    expect(sessions.get(child.id)?.visibility).toBe("private");
  });

  it("refuses an unknown conversation", async () => {
    const { wiring } = setup();
    const r = await handleMakeConversationPrivate(wiring, "nope");
    expect(r.isError).toBe(true);
  });
});
