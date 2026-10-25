/**
 * The sidebar's turn dot: green while the agent works, blue for an unread reply, yellow once that
 * reply's sandbox has gone idle, red for a dead sandbox; and the open conversation is never unread.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { sessionStore, turnDot, type Session } from "./sessions.js";

const row = (id: string) => sessionStore.get().sessions.find((s) => s.serverId === id)!;

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  sessionStore.clearEditing();
  sessionStore.clearHover();
  sessionStore.setQuery("");
});

describe("turnDot", () => {
  const base: Session = { id: "x", title: "t", createdAt: 1, lastActivityAt: 1, status: "running" };

  it("is green while a run is in flight", () => {
    expect(turnDot({ ...base, runStartedAt: 5 })).toBe("active");
  });
  it("is blue for a reply newer than the last one seen", () => {
    expect(turnDot({ ...base, lastReplyAt: 10, lastSeenAt: 5 })).toBe("unread");
  });
  it("is yellow for an unread reply whose sandbox is suspended", () => {
    expect(turnDot({ ...base, status: "suspended", lastReplyAt: 10, lastSeenAt: 5 })).toBe("unread-idle");
  });
  it("ignores a stale in-flight mark on a sandbox that is not running", () => {
    expect(turnDot({ ...base, status: "suspended", runStartedAt: 5 })).toBeUndefined();
  });
  it("is red for a failed sandbox whatever else holds", () => {
    expect(turnDot({ ...base, status: "failed", runStartedAt: 5 })).toBe("failed");
  });
  it("is grey once the reply has been seen while the sandbox is still up", () => {
    expect(turnDot({ ...base, lastReplyAt: 10, lastSeenAt: 10 })).toBe("idle");
  });
  it("is the pink ! while the agent waits on the user, over a run or an unread reply @proves", () => {
    expect(turnDot({ ...base, awaitingInputAt: 7 })).toBe("question");
    expect(turnDot({ ...base, awaitingInputAt: 7, runStartedAt: 5 })).toBe("question");
    expect(turnDot({ ...base, awaitingInputAt: 7, lastReplyAt: 10, lastSeenAt: 5 })).toBe("question");
    // An external approval outlives the sandbox, so a suspended row still asks.
    expect(turnDot({ ...base, status: "suspended", awaitingInputAt: 7 })).toBe("question");
  });
  it("leaves a failed sandbox red even with a question pending", () => {
    expect(turnDot({ ...base, status: "failed", awaitingInputAt: 7 })).toBe("failed");
  });
  it("shows nothing for a read conversation whose sandbox is suspended", () => {
    expect(turnDot({ ...base, status: "suspended", lastReplyAt: 10, lastSeenAt: 10 })).toBeUndefined();
  });
});

describe("unread tracking through the store", () => {
  it("a conversation first seen with a reply starts read", () => {
    sessionStore.mergeFromServer([{ id: "a", lastReplyAt: 100 }, { id: "b", lastReplyAt: 100 }]);
    expect(turnDot(row("b"))).toBeUndefined();
  });

  it("a reply landing in a background conversation is unread until opened", () => {
    sessionStore.mergeFromServer([{ id: "fg", lastReplyAt: 1 }, { id: "bg", lastReplyAt: 1 }]);
    sessionStore.switchTo(row("fg").id);
    sessionStore.mergeFromServer([{ id: "bg", runStartedAt: 2, lastReplyAt: 1 }], { fullList: false });
    expect(turnDot(row("bg"))).toBe("active");
    sessionStore.mergeFromServer([{ id: "bg", lastReplyAt: 3 }], { fullList: false });
    expect(turnDot(row("bg"))).toBe("unread");
    sessionStore.switchTo(row("bg").id);
    expect(turnDot(row("bg"))).toBeUndefined();
  });

  it("the first reply on a row that had none yet is unread", () => {
    sessionStore.mergeFromServer([{ id: "fg2" }, { id: "fresh" }]);
    sessionStore.switchTo(row("fg2").id);
    sessionStore.mergeFromServer([{ id: "fresh", lastReplyAt: 7 }], { fullList: false });
    expect(turnDot(row("fresh"))).toBe("unread");
  });

  it("a reply in the open conversation is read as it lands", () => {
    sessionStore.mergeFromServer([{ id: "open", lastReplyAt: 1 }]);
    sessionStore.switchTo(row("open").id);
    sessionStore.mergeFromServer([{ id: "open", lastReplyAt: 9 }], { fullList: false });
    expect(row("open").lastSeenAt).toBe(9);
    expect(turnDot(row("open"))).toBeUndefined();
  });

  it("the ! follows awaitingInputAt on live upserts, even in the open conversation", () => {
    sessionStore.mergeFromServer([{ id: "q" }]);
    sessionStore.switchTo(row("q").id);
    sessionStore.mergeFromServer([{ id: "q", awaitingInputAt: 5, lastReplyAt: 5 }], { fullList: false });
    expect(turnDot(row("q"))).toBe("question");
    // Every server row is whole, so an upsert without the field means the question was answered.
    sessionStore.mergeFromServer([{ id: "q", runStartedAt: 6, lastReplyAt: 5 }], { fullList: false });
    expect(turnDot(row("q"))).toBe("active");
  });
});
