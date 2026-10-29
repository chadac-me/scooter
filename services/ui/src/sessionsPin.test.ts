/**
 * sessionStore.pin, the `/chat/<id>` subpage's store: it starts clean rather than from the main
 * app's saved list, never writes that list back, and stays on its one conversation. Its own file
 * because the pin is module state for the page's lifetime, and vitest isolates modules per file.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";

const PINNED = "11111111-0000-4000-8000-000000000001";
const OTHER = "22222222-0000-4000-8000-000000000002";

// In place before sessions.ts is imported, since it reads the saved list at import.
const { stored, KEY, SAVED } = vi.hoisted(() => {
  const KEY = "kubenix-agent.sessions.v1";
  const SAVED = JSON.stringify({
    sessions: [
      { id: "main-app-row", title: "Main app", createdAt: 1, lastActivityAt: 1, serverId: "11111111-0000-4000-8000-000000000001" },
    ],
    currentId: "main-app-row",
  });
  const stored = new Map<string, string>([[KEY, SAVED]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
    clear: () => stored.clear(),
  });
  return { stored, KEY, SAVED };
});

import { sessionStore } from "./sessions.js";

beforeAll(() => {
  // The main app's saved list really was loaded, so the pin is what discards it.
  expect(sessionStore.get().sessions.map((s) => s.id)).toContain("main-app-row");
  sessionStore.pin(PINNED);
});

describe("sessionStore.pin (the /chat/<id> subpage)", () => {
  it("does not adopt the main app's saved list, whose local key would shadow the server id", () => {
    expect(sessionStore.pinned()).toBe(PINNED);
    expect(sessionStore.get().sessions.some((s) => s.id === "main-app-row")).toBe(false);
  });

  it("selects the pinned conversation once the server lists it", () => {
    expect(sessionStore.get().currentId).not.toBe(PINNED);
    sessionStore.mergeFromServer([{ id: OTHER, title: "Other" }, { id: PINNED, title: "Pinned" }]);
    expect(sessionStore.get().currentId).toBe(PINNED);
  });

  it("cannot be moved to another conversation", () => {
    sessionStore.switchTo(OTHER);
    expect(sessionStore.get().currentId).toBe(PINNED);
    sessionStore.newSession();
    expect(sessionStore.get().currentId).toBe(PINNED);
    sessionStore.deleteSession(OTHER);
    expect(sessionStore.get().currentId).toBe(PINNED);
  });

  it("never writes over the main app's saved list", () => {
    expect(stored.get(KEY)).toBe(SAVED);
  });
});
