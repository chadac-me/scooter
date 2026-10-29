/**
 * Private conversations in the UI: who sees the toggle, the warning before going shared, the
 * optimistic change and its revert, and the server's visibility surviving a merge.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { conversationFor, sessionStore, setConversationMinter, type Session } from "./sessions.js";
import { MAKE_SHARED_WARNING, canChangeVisibility, toggleVisibility } from "./sessionActions.js";

const stubFetch = (status = 200) => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
      return { ok: status >= 200 && status < 300, status, json: async () => ({ id: "conv-v" }) };
    }) as never,
  );
  return calls;
};

const current = (key: string): Session => sessionStore.get().sessions.find((x) => x.id === key)!;

const created = async (serverId: string, over: Partial<Session> = {}): Promise<Session> => {
  setConversationMinter(async () => serverId);
  const key = sessionStore.newSession();
  await conversationFor(current(key)).ensureCreated();
  sessionStore.mergeFromServer([{ id: serverId, owner: "alice", ...(over.visibility ? { visibility: over.visibility } : {}) }]);
  return current(key);
};

beforeEach(() => globalThis.localStorage?.clear?.());
afterEach(() => vi.unstubAllGlobals());

describe("canChangeVisibility", () => {
  const s = (over: Partial<Session>): Session => ({ id: "k", title: "t", serverId: "c1", serverCreated: true, owner: "alice", ...over }) as Session;

  it("is the owner's, on a created top-level conversation", () => {
    expect(canChangeVisibility(s({}), "alice", false)).toBe(true);
  });
  it("is nobody else's", () => {
    expect(canChangeVisibility(s({}), "bob", false)).toBe(false);
    expect(canChangeVisibility(s({}), "anonymous", true)).toBe(false);
    expect(canChangeVisibility(s({ owner: undefined }), "alice", false)).toBe(false);
  });
  it("is never offered on a subagent, which follows its parent", () => {
    expect(canChangeVisibility(s({ parentId: "root" }), "alice", false)).toBe(false);
  });
});

describe("toggleVisibility", () => {
  it("makes a shared conversation private without asking", async () => {
    const s = await created("conv-v1");
    const calls = stubFetch();
    const confirm = vi.fn(() => true);
    await toggleVisibility(s, confirm);
    expect(confirm).not.toHaveBeenCalled();
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toMatch(/\/conversations\/conv-v1\/visibility$/);
    expect(JSON.parse(patch.body!)).toEqual({ visibility: "private" });
    expect(current(s.id).visibility).toBe("private");
  });

  it("asks before making a private conversation shared, and sends confirm", async () => {
    const s = await created("conv-v2", { visibility: "private" });
    const calls = stubFetch();
    const confirm = vi.fn(() => true);
    await toggleVisibility(s, confirm);
    expect(confirm).toHaveBeenCalledWith(MAKE_SHARED_WARNING);
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toEqual({ visibility: "shared", confirm: true });
    expect(current(s.id).visibility).toBe("shared");
  });

  it("does nothing when the user declines the warning", async () => {
    const s = await created("conv-v3", { visibility: "private" });
    const calls = stubFetch();
    await toggleVisibility(s, () => false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(current(s.id).visibility).toBe("private");
  });

  it("reverts the optimistic change when the server refuses", async () => {
    const s = await created("conv-v4");
    stubFetch(403);
    await toggleVisibility(s, () => true);
    expect(current(s.id).visibility ?? "shared").toBe("shared");
  });
});

describe("merge", () => {
  it("takes the server's visibility", async () => {
    const s = await created("conv-v5");
    sessionStore.mergeFromServer([{ id: "conv-v5", visibility: "private" }]);
    expect(current(s.id).visibility).toBe("private");
  });
});
