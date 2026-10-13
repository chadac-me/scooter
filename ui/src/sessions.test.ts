/**
 * Session store unit tests: deep-link selection, merge reference stability, link-source
 * ownership, the rename lock, per-conversation models, starring, subagent pruning and
 * nesting, and the rule that only the server issues conversation ids.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  conversationFor,
  sessionStore,
  setConversationMinter,
  visibleSessions,
  nestSubagents,
  splitSections,
  type Session,
  type SidebarRow,
} from "./sessions.js";

beforeEach(() => {
  globalThis.localStorage?.clear?.();
  // The store is a module singleton, so a leaked rename lock would freeze every later test's mergeFromServer.
  sessionStore.clearEditing();
  // A leaked query would decide whether a rename lock is still honored.
  sessionStore.setQuery("");
});

describe("deep-link selection (requestSelect)", () => {
  it("selects a conversation that is ALREADY in the list immediately", () => {
    sessionStore.mergeFromServer([{ id: "known-1" }, { id: "known-2" }]);
    sessionStore.requestSelect("known-2");
    expect(sessionStore.get().currentId).toBe("known-2");
  });

  it("selects a NOT-yet-known conversation once it arrives via the server", () => {
    // The deep-link target is not in the list yet.
    sessionStore.requestSelect("from-slack");
    expect(sessionStore.get().currentId).not.toBe("from-slack");
    expect(sessionStore.get().pendingSelect).toBe("from-slack");

    // Once it arrives it is selected and the pending clears.
    sessionStore.mergeFromServer([{ id: "from-slack", title: "Slack: help" }]);
    expect(sessionStore.get().currentId).toBe("from-slack");
    expect(sessionStore.get().pendingSelect).toBeUndefined();
  });

  it("a background merge does NOT hijack the selection (still selection-neutral)", () => {
    sessionStore.mergeFromServer([{ id: "a", title: "Conv A" }]);
    sessionStore.requestSelect("a");
    expect(sessionStore.get().currentId).toBe("a");
    // A later merge bringing a newer conversation must not move the selection.
    const now = Date.now();
    sessionStore.mergeFromServer([
      { id: "a", title: "Conv A" },
      { id: "b", title: "Conv B", createdAt: now + 1000, lastActivityAt: now + 1000 },
    ]);
    expect(sessionStore.get().currentId).toBe("a");
  });
});

describe("merge reference stability (sidebar re-render / flake root)", () => {
  const byId = (id: string) => sessionStore.get().sessions.find((s) => s.id === id);

  it("reuses the SAME object reference for an unchanged conversation across merges", () => {
    sessionStore.mergeFromServer([{ id: "ref-a", title: "Alpha", createdAt: 1000, lastActivityAt: 1000 }]);
    const first = byId("ref-a");
    // A later poll returns the same conversation, unchanged.
    sessionStore.mergeFromServer([{ id: "ref-a", title: "Alpha", createdAt: 1000, lastActivityAt: 1000 }]);
    const second = byId("ref-a");
    // The same reference lets React.memo skip the row.
    expect(second).toBe(first);
  });

  it("produces a NEW reference only for the conversation that actually changed", () => {
    sessionStore.mergeFromServer([
      { id: "ch-x", title: "X", createdAt: 1, lastActivityAt: 1 },
      { id: "ch-y", title: "Y", createdAt: 2, lastActivityAt: 2 },
    ]);
    const x1 = byId("ch-x");
    const y1 = byId("ch-y");
    // Only Y's title changes on the next poll.
    sessionStore.mergeFromServer([
      { id: "ch-x", title: "X", createdAt: 1, lastActivityAt: 1 },
      { id: "ch-y", title: "Y renamed", createdAt: 2, lastActivityAt: 2 },
    ]);
    expect(byId("ch-x")).toBe(x1);
    expect(byId("ch-y")).not.toBe(y1);
    expect(byId("ch-y")?.title).toBe("Y renamed");
  });
});

describe("link sources ownership (poll owns them; an SSE upsert must not clobber)", () => {
  const sourcesOf = (id: string) => sessionStore.get().sessions.find((s) => s.id === id)?.sources;

  it("a []-sources single-row upsert does NOT wipe poll-populated sources (the sidebar-icon flake)", () => {
    // A single-row upsert always carries `sources: []`, which must not clobber the poll-populated sources.
    sessionStore.mergeFromServer([{ id: "conv-1", sources: ["github"] }]); // authoritative poll
    expect(sourcesOf("conv-1")).toEqual(["github"]);
    sessionStore.mergeFromServer([{ id: "conv-1", sources: [] }], { sourcesAuthoritative: false });
    expect(sourcesOf("conv-1")).toEqual(["github"]);
  });

  it("an authoritative poll STILL clears sources when a link is removed (poll owns them)", () => {
    sessionStore.mergeFromServer([{ id: "conv-2", sources: ["github"] }]);
    // An authoritative poll reflecting the link removal must take effect.
    sessionStore.mergeFromServer([{ id: "conv-2", sources: [] }]);
    expect(sourcesOf("conv-2")).toEqual([]);
  });

  it("a NEW conversation arriving only via upsert has no sources (poll/snapshot fills them later)", () => {
    sessionStore.mergeFromServer([{ id: "conv-3", sources: [] }], { sourcesAuthoritative: false });
    expect(sourcesOf("conv-3") ?? []).toEqual([]);
  });
});

describe("editing lock (rename in progress freezes the sidebar — the CI rename flake)", () => {
  const byId = (id: string) => sessionStore.get().sessions.find((s) => s.id === id);

  it("a merge does NOT mutate the row being renamed (title/userTitled held)", () => {
    sessionStore.mergeFromServer([{ id: "edit-a", title: "Original", createdAt: 1, lastActivityAt: 1 }]);
    sessionStore.setEditing("edit-a");
    // An agent title landing mid-rename must be ignored for the editing row.
    sessionStore.mergeFromServer([{ id: "edit-a", title: "Agent-picked title", createdAt: 1, lastActivityAt: 1 }]);
    expect(byId("edit-a")?.title).toBe("Original");
    expect(byId("edit-a")?.userTitled).toBeFalsy();
  });

  it("keeps the SAME object reference for the editing row across a merge (React.memo skips it)", () => {
    sessionStore.mergeFromServer([{ id: "edit-ref", title: "Alpha", createdAt: 2, lastActivityAt: 2 }]);
    sessionStore.setEditing("edit-ref");
    const before = byId("edit-ref");
    // A merge that would otherwise change the title must not touch it.
    sessionStore.mergeFromServer([{ id: "edit-ref", title: "Changed by agent", createdAt: 2, lastActivityAt: 2 }]);
    expect(byId("edit-ref")).toBe(before);
  });

  it("freezes the WHOLE sidebar while renaming (a merge is a full no-op, not just per-row)", () => {
    sessionStore.mergeFromServer([
      { id: "lock-a", title: "A", createdAt: 1, lastActivityAt: 1 },
      { id: "lock-b", title: "B", createdAt: 2, lastActivityAt: 2 },
    ]);
    sessionStore.setEditing("lock-a");
    // While any rename is open, a merge that changes both the editing row and another row is dropped entirely.
    sessionStore.mergeFromServer([
      { id: "lock-a", title: "A changed", createdAt: 1, lastActivityAt: 1 },
      { id: "lock-b", title: "B changed", createdAt: 2, lastActivityAt: 2 },
    ]);
    expect(byId("lock-a")?.title).toBe("A");
    expect(byId("lock-b")?.title).toBe("B");
  });

  it("applies server-truth again once the rename clears", () => {
    sessionStore.mergeFromServer([{ id: "edit-clear", title: "Original", createdAt: 3, lastActivityAt: 3 }]);
    sessionStore.setEditing("edit-clear");
    sessionStore.mergeFromServer([{ id: "edit-clear", title: "Agent title", createdAt: 3, lastActivityAt: 3 }]);
    expect(byId("edit-clear")?.title).toBe("Original"); // held while editing
    // Once the lock clears the next merge applies again.
    sessionStore.clearEditing("edit-clear");
    sessionStore.mergeFromServer([{ id: "edit-clear", title: "Agent title", createdAt: 3, lastActivityAt: 3 }]);
    expect(byId("edit-clear")?.title).toBe("Agent title");
  });

  it("clearEditing(id) is a no-op when a DIFFERENT row is being edited", () => {
    sessionStore.mergeFromServer([{ id: "ce-a", title: "A", createdAt: 1, lastActivityAt: 1 }]);
    sessionStore.setEditing("ce-a");
    sessionStore.clearEditing("ce-b"); // stale clear from another row
    expect(sessionStore.get().editingId).toBe("ce-a");
    sessionStore.clearEditing("ce-a");
    expect(sessionStore.get().editingId).toBeUndefined();
  });

  it("RELEASES a lock whose row has left the rendered list (the freeze can't become permanent)", () => {
    sessionStore.mergeFromServer([
      { id: "stuck-a", title: "Alpha", createdAt: 1, lastActivityAt: 1 },
      { id: "stuck-b", title: "Beta", createdAt: 2, lastActivityAt: 2 },
    ]);
    sessionStore.setEditing("stuck-a");
    // The search hides the row being renamed, so its input unmounts and nothing can ever clear the lock from the row.
    sessionStore.setQuery("Beta");
    sessionStore.mergeFromServer([
      { id: "stuck-a", title: "Alpha changed", createdAt: 1, lastActivityAt: 1 },
      { id: "stuck-b", title: "Beta changed", createdAt: 2, lastActivityAt: 2 },
    ]);
    expect(sessionStore.get().editingId).toBeUndefined();
    expect(byId("stuck-a")?.title).toBe("Alpha changed"); // the merge ran as well as the unlock
    expect(byId("stuck-b")?.title).toBe("Beta changed");
  });

  it("a user rename made during editing survives the merge that arrives before clear", () => {
    sessionStore.mergeFromServer([{ id: "edit-user", title: "Original", createdAt: 4, lastActivityAt: 4 }]);
    sessionStore.setEditing("edit-user");
    sessionStore.renameSession("edit-user", "My pinned project"); // optimistic and locked
    // A poll still reporting the agent's guess arrives before the input closes.
    sessionStore.mergeFromServer([{ id: "edit-user", title: "Agent guess", createdAt: 4, lastActivityAt: 4 }]);
    expect(byId("edit-user")?.title).toBe("My pinned project");
    expect(byId("edit-user")?.userTitled).toBe(true);
  });
});

describe("per-conversation model (model-switch scoping)", () => {
  it("setModel changes ONLY the target conversation, never the others", () => {
    sessionStore.mergeFromServer([{ id: "a" }, { id: "b" }, { id: "c" }]);
    sessionStore.setModel("a", "claude-sonnet-4-6");

    const byId = Object.fromEntries(sessionStore.get().sessions.map((s) => [s.id, s.model]));
    expect(byId.a).toBe("claude-sonnet-4-6");
    expect(byId.b).toBeUndefined();
    expect(byId.c).toBeUndefined();
  });

  it("a background list-refresh does NOT propagate one conversation's model to the rest", () => {
    // After switching A, a poll arrives and B/C must keep their own unset model.
    sessionStore.mergeFromServer([{ id: "a" }, { id: "b" }, { id: "c" }]);
    sessionStore.setModel("a", "claude-sonnet-4-6");

    // The poll reports A's persisted pick and no model for B/C.
    sessionStore.mergeFromServer([
      { id: "a", model: "claude-sonnet-4-6" },
      { id: "b" },
      { id: "c" },
    ]);

    const byId = Object.fromEntries(sessionStore.get().sessions.map((s) => [s.id, s.model]));
    expect(byId.a).toBe("claude-sonnet-4-6");
    expect(byId.b).toBeUndefined();
    expect(byId.c).toBeUndefined();
  });

  it("a locally-chosen model survives a poll that hasn't persisted it yet (first send pending)", () => {
    // A switch made before the first prompt persists it must not be clobbered by a poll that still reports no model.
    sessionStore.mergeFromServer([{ id: "a" }]);
    sessionStore.setModel("a", "claude-haiku-4-5");
    sessionStore.mergeFromServer([{ id: "a" /* server hasn't stored the model yet */ }]);
    expect(sessionStore.get().sessions.find((s) => s.id === "a")?.model).toBe("claude-haiku-4-5");
  });

  it("switching conversations does not carry a model between them (switchTo is model-neutral)", () => {
    sessionStore.mergeFromServer([{ id: "a" }, { id: "b" }]);
    sessionStore.setModel("a", "claude-sonnet-4-6");
    sessionStore.switchTo("b");
    // B's model is still its own, not A's pick.
    expect(sessionStore.get().sessions.find((s) => s.id === "b")?.model).toBeUndefined();
    expect(sessionStore.get().currentId).toBe("b");
  });
});

describe("favoriting pins a conversation to the top of the list", () => {
  // Unique ids avoid cross-test accumulation in the singleton store, and `only` restricts the assertion to them.
  const only = (...ids: string[]) => sessionStore.get().sessions.filter((s) => ids.includes(s.id)).map((s) => s.id);

  it("starred conversations sort ABOVE unstarred ones (then most-recently-active first within each group)", () => {
    sessionStore.mergeFromServer([
      { id: "star-old", title: "Old", createdAt: 1_000, lastActivityAt: 1_000 },
      { id: "star-mid", title: "Mid", createdAt: 2_000, lastActivityAt: 2_000 },
      { id: "star-new", title: "New", createdAt: 3_000, lastActivityAt: 3_000 },
    ]);
    expect(only("star-new", "star-mid", "star-old")).toEqual(["star-new", "star-mid", "star-old"]);

    // Starring the oldest moves it to the top despite being least recent.
    sessionStore.setStarred("star-old", true);
    expect(only("star-new", "star-mid", "star-old")).toEqual(["star-old", "star-new", "star-mid"]);
  });

  it("re-sorts immediately on toggle (no wait for a server merge)", () => {
    sessionStore.mergeFromServer([
      { id: "imm-a", title: "A", createdAt: 3_000, lastActivityAt: 3_000 },
      { id: "imm-b", title: "B", createdAt: 2_000, lastActivityAt: 2_000 },
      { id: "imm-c", title: "C", createdAt: 1_000, lastActivityAt: 1_000 },
    ]);
    sessionStore.setStarred("imm-c", true);
    sessionStore.setStarred("imm-b", true);
    // Both starred rows sort above imm-a, most recently active first.
    expect(only("imm-a", "imm-b", "imm-c")).toEqual(["imm-b", "imm-c", "imm-a"]);
  });

  it("un-starring drops a conversation back into recency order", () => {
    sessionStore.mergeFromServer([
      { id: "un-a", title: "A", createdAt: 3_000, lastActivityAt: 3_000, starred: true },
      { id: "un-b", title: "B", createdAt: 2_000, lastActivityAt: 2_000 },
      { id: "un-c", title: "C", createdAt: 1_000, lastActivityAt: 1_000 },
    ]);
    expect(only("un-a", "un-b", "un-c")).toEqual(["un-a", "un-b", "un-c"]);
    sessionStore.setStarred("un-a", false);
    expect(only("un-a", "un-b", "un-c")).toEqual(["un-a", "un-b", "un-c"]); // a @3000 is still most recent
  });

  it("a server merge that only flips a star re-orders (not skipped by the no-op guard)", () => {
    sessionStore.mergeFromServer([
      { id: "poll-a", title: "A", createdAt: 3_000, lastActivityAt: 3_000 },
      { id: "poll-b", title: "B", createdAt: 1_000, lastActivityAt: 1_000 },
    ]);
    expect(only("poll-a", "poll-b")).toEqual(["poll-a", "poll-b"]);
    // The next poll reports b as starred.
    sessionStore.mergeFromServer([
      { id: "poll-a", title: "A", createdAt: 3_000, lastActivityAt: 3_000 },
      { id: "poll-b", title: "B", createdAt: 1_000, lastActivityAt: 1_000, starred: true },
    ]);
    expect(only("poll-a", "poll-b")).toEqual(["poll-b", "poll-a"]);
  });
});

describe("ended subagents are pruned from the sidebar", () => {
  it("drops a subagent the server no longer lists (it ended), keeping the parent", () => {
    // Parent + subagent both known.
    sessionStore.mergeFromServer([
      { id: "parent-1", title: "Parent" },
      { id: "sub-1", title: "echo test", parentId: "parent-1" },
    ]);
    expect(sessionStore.get().sessions.some((s) => s.id === "sub-1")).toBe(true);

    // The next poll omits the subagent because it ended.
    sessionStore.mergeFromServer([{ id: "parent-1", title: "Parent" }]);
    const ids = sessionStore.get().sessions.map((s) => s.id);
    expect(ids).toContain("parent-1");
    expect(ids).not.toContain("sub-1");
  });

  it("does NOT prune a top-level conversation missing from a single merge", () => {
    // A top-level conversation may just be filtered out of this scope.
    sessionStore.mergeFromServer([{ id: "top-1", title: "Real chat" }]);
    sessionStore.mergeFromServer([{ id: "other", title: "Other" }]);
    expect(sessionStore.get().sessions.some((s) => s.id === "top-1")).toBe(true);
  });
});

describe("a brand-new conversation survives the background merge", () => {
  it("does NOT drop the currently-selected 'New chat' the server hasn't seen yet", async () => {
    // A real server conversation exists for the merge to reconcile against.
    sessionStore.mergeFromServer([{ id: "server-conv", title: "Existing" }]);

    // "New chat" creates a pristine, server-unknown, selected session.
    const fresh = sessionStore.newSession();
    expect(sessionStore.get().currentId).toBe(fresh);

    // A poll that does not include the new chat must neither drop it nor move the selection.
    sessionStore.mergeFromServer([{ id: "server-conv", title: "Existing" }]);

    expect(sessionStore.get().sessions.some((s) => s.id === fresh)).toBe(true);
    expect(sessionStore.get().currentId).toBe(fresh);
  });

  it("still drops a pristine placeholder the user has LEFT (not selected)", () => {
    // Selecting the real conversation leaves the pristine placeholder as a genuine phantom.
    const pristine = sessionStore.get().currentId; // the initial fresh "New chat"
    sessionStore.mergeFromServer([{ id: "real", title: "Real" }]);
    sessionStore.switchTo("real");
    expect(sessionStore.get().currentId).toBe("real");

    // A later merge that still does not know the placeholder drops it.
    sessionStore.mergeFromServer([{ id: "real", title: "Real" }]);
    expect(sessionStore.get().sessions.some((s) => s.id === pristine)).toBe(false);
  });
});

describe("user rename + starring", () => {
  const titleOf = (id: string) => sessionStore.get().sessions.find((s) => s.id === id)?.title;
  const of = (id: string) => sessionStore.get().sessions.find((s) => s.id === id);

  it("renameSession sets the title and LOCKS it (userTitled) against the agent", () => {
    sessionStore.mergeFromServer([{ id: "c", title: "Agent guess" }]);
    sessionStore.renameSession("c", "My name");
    expect(titleOf("c")).toBe("My name");
    expect(of("c")?.userTitled).toBe(true);

    // The agent's new title is ignored because the title is locked.
    sessionStore.setTitle("c", "Agent's new guess");
    expect(titleOf("c")).toBe("My name");
  });

  it("a server userTitled merge wins over a stale local title immediately", () => {
    // The server reports a user rename over a local agent title.
    sessionStore.mergeFromServer([{ id: "c", title: "Agent guess" }]);
    sessionStore.mergeFromServer([{ id: "c", title: "Pinned by user", userTitled: true }]);
    expect(titleOf("c")).toBe("Pinned by user");
    expect(of("c")?.userTitled).toBe(true);
  });

  it("setStarred toggles the flag, and a server merge carries it", () => {
    sessionStore.mergeFromServer([{ id: "c", title: "X" }]);
    expect(of("c")?.starred).toBeFalsy();
    sessionStore.setStarred("c", true);
    expect(of("c")?.starred).toBe(true);
    // The server confirms it on the next merge.
    sessionStore.mergeFromServer([{ id: "c", title: "X", starred: true }]);
    expect(of("c")?.starred).toBe(true);
  });
});

describe("visibleSessions (Mine/All owner filter)", () => {
  const seed = () =>
    sessionStore.mergeFromServer([
      { id: "a1", title: "Alice", owner: "alice" },
      { id: "b1", title: "Bob", owner: "bob" },
      { id: "u1", title: "Unowned", owner: undefined },
    ]);
  const titles = () =>
    visibleSessions(sessionStore.get())
      .map((s) => s.title)
      .filter((t): t is string => !!t)
      .sort();

  it("ANONYMOUS caller sees everything under Mine (id is the truthy string 'anonymous' — guard on the flag)", () => {
    seed();
    sessionStore.setCurrentUser({ id: "anonymous", anonymous: true });
    sessionStore.setScope("mine");
    // The id "anonymous" is truthy, so the filter must guard on the flag and keep every conversation visible.
    const t = titles();
    expect(t).toContain("Alice");
    expect(t).toContain("Bob");
    expect(t).toContain("Unowned");
  });

  it("a KNOWN user under Mine sees STRICTLY their own (not others, not unowned)", () => {
    seed();
    sessionStore.setCurrentUser({ id: "alice", email: "alice@x.io", anonymous: false });
    sessionStore.setScope("mine");
    // Bob's and every unowned conversation are hidden.
    expect(titles()).toEqual(["Alice"]);
  });

  it("a KNOWN user under All sees everything", () => {
    seed();
    sessionStore.setCurrentUser({ id: "alice", anonymous: false });
    sessionStore.setScope("all");
    const t = titles();
    expect(t).toContain("Alice");
    expect(t).toContain("Bob");
    expect(t).toContain("Unowned");
  });
});

describe("nestSubagents (sidebar hierarchy)", () => {
  const s = (id: string, parentId?: string): Session => ({ id, title: id, createdAt: 1, lastActivityAt: 1, parentId });

  it("with no activeId, expands every parent's children", () => {
    // Flat input with the children of p1 and p2 interleaved.
    const flat = [s("p1"), s("p2"), s("c1a", "p1"), s("c2a", "p2"), s("c1b", "p1")];
    const rows = nestSubagents(flat);
    expect(rows.map((r) => r.session.id)).toEqual(["p1", "c1a", "c1b", "p2", "c2a"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0, 1]);
  });

  it("AUTO-COLLAPSES a parent's children when neither the parent nor a child is active", () => {
    const flat = [s("p1"), s("c1a", "p1"), s("c1b", "p1"), s("p2"), s("c2a", "p2")];
    // p2 is active, so its children expand and p1 collapses.
    const rows = nestSubagents(flat, "p2");
    expect(rows.map((r) => r.session.id)).toEqual(["p1", "p2", "c2a"]);
    // The collapsed parent carries its child count.
    expect(rows.find((r) => r.session.id === "p1")?.childCount).toBe(2);
    // The expanded parent has no hidden children.
    expect(rows.find((r) => r.session.id === "p2")?.childCount).toBe(0);
  });

  it("expands a parent's children when a CHILD is the active conversation", () => {
    const flat = [s("p1"), s("c1a", "p1"), s("c1b", "p1"), s("p2"), s("c2a", "p2")];
    // c1a is a child of p1, so p1's branch expands and p2 collapses.
    const rows = nestSubagents(flat, "c1a");
    expect(rows.map((r) => r.session.id)).toEqual(["p1", "c1a", "c1b", "p2"]);
  });

  it("a child whose parent is NOT in the list renders as a top-level row", () => {
    // The parent was filtered out, so the orphaned child still shows.
    const rows = nestSubagents([s("orphan", "missing-parent")]);
    expect(rows.map((r) => r.session.id)).toEqual(["orphan"]);
    expect(rows[0].depth).toBe(0);
  });

  it("top-level-only list is unchanged (all depth 0)", () => {
    const rows = nestSubagents([s("a"), s("b")]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });
});

describe("splitSections (Starred / Recent — a conversation appears in exactly ONE)", () => {
  const row = (s: Partial<Session> & { id: string }, depth = 0): SidebarRow => ({
    session: { title: s.id, createdAt: 1, lastActivityAt: 1, ...s },
    depth,
    childCount: 0,
  });
  const ids = (rows: SidebarRow[]) => rows.map((r) => r.session.id);

  it("routes a starred conversation to Starred and everything else to Recent", () => {
    const { starred, recent } = splitSections([
      row({ id: "a", starred: true }),
      row({ id: "b" }),
      row({ id: "c" }),
    ]);
    expect(ids(starred)).toEqual(["a"]);
    expect(ids(recent)).toEqual(["b", "c"]);
  });

  it("renders a DOUBLE-HELD conversation once, in Starred — the reported bug", () => {
    // The list can hold the same conversation twice (a locally keyed row next to the server's own row), and `starred` is a per-row flag.
    const { starred, recent } = splitSections([
      row({ id: "local-key", serverId: "conv-1", starred: true }),
      row({ id: "conv-1", serverId: "conv-1" }),
      row({ id: "other" }),
    ]);
    expect(ids(starred)).toEqual(["local-key"]);
    expect(ids(recent)).toEqual(["other"]);
  });

  it("puts the conversation in Starred even when the unstarred copy comes first", () => {
    // Routing is per conversation, not by whichever row the walk reaches first.
    const { starred, recent } = splitSections([
      row({ id: "conv-2", serverId: "conv-2" }),
      row({ id: "local-key-2", serverId: "conv-2", starred: true }),
    ]);
    expect(ids(starred)).toEqual(["conv-2"]);
    expect(recent).toEqual([]);
  });

  it("subagent rows inherit their parent's section", () => {
    const { starred, recent } = splitSections([
      row({ id: "p1", starred: true }),
      row({ id: "c1", parentId: "p1" }, 1),
      row({ id: "p2" }),
      row({ id: "c2", parentId: "p2" }, 1),
    ]);
    expect(ids(starred)).toEqual(["p1", "c1"]);
    expect(ids(recent)).toEqual(["p2", "c2"]);
  });

  it("a dropped duplicate parent takes its subagent rows with it (no orphans)", () => {
    const { starred, recent } = splitSections([
      row({ id: "p-key", serverId: "p", starred: true }),
      row({ id: "kid", serverId: "kid", parentId: "p" }, 1),
      row({ id: "p", serverId: "p" }),
      row({ id: "kid-again", serverId: "kid", parentId: "p" }, 1),
    ]);
    expect(ids(starred)).toEqual(["p-key", "kid"]);
    expect(recent).toEqual([]);
  });
});

describe("a phantom local conversation never shadows its real server row", () => {
  it("prunes a never-created row the server does not list (once it is not the selection)", () => {
    // A row with a title but no server id can only shadow the conversation it was meant to become.
    const ghost = sessionStore.newSession();
    sessionStore.setTitle(ghost, "lost create");
    sessionStore.mergeFromServer([{ id: "phantom-real", title: "lost create" }]);
    sessionStore.switchTo("phantom-real");
    sessionStore.mergeFromServer([{ id: "phantom-real", title: "lost create" }]);

    const listed = sessionStore.get().sessions.map((s) => s.id);
    expect(listed).toContain("phantom-real");
    expect(listed).not.toContain(ghost);
  });

  it("keeps it while it IS the selection (an unsent conversation being typed into)", () => {
    const draft = sessionStore.newSession();
    sessionStore.setTitle(draft, "typing right now");
    sessionStore.mergeFromServer([{ id: "phantom-other", title: "Other" }]);
    expect(sessionStore.get().sessions.map((s) => s.id)).toContain(draft);
  });

  it("keeps a SERVER-created conversation that a single merge does not mention", () => {
    // A real conversation missing from one merge may just be scoped out.
    sessionStore.mergeFromServer([{ id: "phantom-kept", title: "Real chat" }]);
    sessionStore.mergeFromServer([{ id: "phantom-else", title: "Else" }]);
    expect(sessionStore.get().sessions.map((s) => s.id)).toContain("phantom-kept");
  });
});

describe("the SERVER owns conversation ids", () => {
  it("newSession() selects the new conversation SYNCHRONOUSLY (no server round-trip)", () => {
    // A server round-trip here would leave a fast typist sending into the previous conversation.
    const mint = vi.fn(async () => "must-not-be-called-yet");
    setConversationMinter(mint);

    const id = sessionStore.newSession();

    expect(mint).not.toHaveBeenCalled();
    expect(sessionStore.get().currentId).toBe(id);
    expect(sessionStore.current().serverCreated).toBe(false);
  });

  it("the server id is RECORDED on the first send — the stable key does not change", async () => {
    // The server id is recorded alongside the key everything is mounted on, not in place of it.
    sessionStore.newSession();
    const key = sessionStore.get().currentId;
    setConversationMinter(async () => "server-assigned-id");

    const id = await sessionStore.ensureCurrentCreated();

    expect(id).toBe("server-assigned-id");
    expect(sessionStore.get().currentId).toBe(key);
    expect(sessionStore.current().serverId).toBe("server-assigned-id");
    expect(sessionStore.current().serverCreated).toBe(true);
  });

  it("a failed create leaves the store UNTOUCHED", async () => {
    sessionStore.newSession();
    const before = sessionStore.get();

    setConversationMinter(async () => null);
    const id = await sessionStore.ensureCurrentCreated();

    expect(id).toBeNull();
    expect(sessionStore.get().currentId).toBe(before.currentId);
    expect(sessionStore.get().sessions).toHaveLength(before.sessions.length);
  });

  it("a locally-seeded conversation gets a server id without changing its key", async () => {
    // freshState() and deleteSession() seed conversations whose keys are local placeholders.
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    const key = sessionStore.get().currentId;
    expect(sessionStore.current().serverCreated).toBeFalsy();
    expect(sessionStore.current().serverId).toBeUndefined();

    setConversationMinter(async () => "real-id");
    const id = await sessionStore.ensureCurrentCreated();

    expect(id).toBe("real-id");
    expect(sessionStore.get().currentId).toBe(key); // unchanged, so nothing is remounted
    expect(sessionStore.current().serverId).toBe("real-id");
  });

  it("ensureCurrentCreated() is a NO-OP for an already-created conversation", async () => {
    setConversationMinter(async () => "made-once");
    sessionStore.newSession();
    await sessionStore.ensureCurrentCreated();

    const mint = vi.fn(async () => "must-not-be-used");
    setConversationMinter(mint);
    const id = await sessionStore.ensureCurrentCreated();

    expect(mint).not.toHaveBeenCalled();
    expect(id).toBe("made-once");
  });

  it("CONCURRENT ensureCurrentCreated() calls share ONE create", async () => {
    // Every mount asks, so overlapping calls must share one POST /conversations.
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    let calls = 0;
    setConversationMinter(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return `server-${calls}`;
    });

    const [a, b, c] = await Promise.all([
      sessionStore.ensureCurrentCreated(),
      sessionStore.ensureCurrentCreated(),
      sessionStore.ensureCurrentCreated(),
    ]);

    expect(calls).toBe(1);
    expect(a).toBe("server-1");
    expect(b).toBe("server-1");
    expect(c).toBe("server-1");
    expect(sessionStore.get().sessions).toHaveLength(1);
  });

  it("a conversation rebuilt after a RELOAD addresses the server by its SERVER id", async () => {
    // A reload rebuilds every Conversation from the persisted session, whose key may be a local placeholder.
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    setConversationMinter(async () => "real-server-id");
    await sessionStore.ensureCurrentCreated();

    const key = sessionStore.get().currentId;
    const persisted = sessionStore.current();
    expect(persisted.serverId).toBe("real-server-id");
    expect(key).not.toBe("real-server-id"); // the key stayed local

    // Rebuild from the persisted record alone, as a reload would.
    const rebuilt = conversationFor(persisted);
    expect(rebuilt.serverId()).toBe("real-server-id");
    expect(rebuilt.key).toBe(key);
    expect(await rebuilt.ifCreated(async (id) => id, "not-created")).toBe("real-server-id");
  });

  it("a merge does NOT duplicate a conversation created on its first send", async () => {
    // The merge is keyed by server id, while a conversation created on its first send keeps its local key.
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    setConversationMinter(async () => "server-abc");
    await sessionStore.ensureCurrentCreated();
    const key = sessionStore.get().currentId;

    // The poll returns that conversation under its server id.
    sessionStore.mergeFromServer([{ id: "server-abc", title: "From the server" }]);

    expect(sessionStore.get().sessions).toHaveLength(1);
    // The merge did not swap the stable key out from under the mounted runtime.
    expect(sessionStore.get().currentId).toBe(key);
    expect(sessionStore.current().serverId).toBe("server-abc");
    expect(sessionStore.current().title).toBe("From the server");
  });

  it("a server-listed conversation is never re-created", async () => {
    sessionStore.mergeFromServer([{ id: "from-server", title: "Existing" }]);
    sessionStore.switchTo("from-server");

    const mint = vi.fn(async () => "must-not-be-used");
    setConversationMinter(mint);
    const id = await sessionStore.ensureCurrentCreated();

    expect(mint).not.toHaveBeenCalled();
    expect(id).toBe("from-server");
  });
});

describe("the local key must never be used as a server id", () => {
  it("a pending conversation exposes NO server id to address the server with", async () => {
    // An uncreated conversation has nothing that can be sent to the server.
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    const key = sessionStore.get().currentId;
    const conv = conversationFor(sessionStore.current());

    expect(conv.serverId()).toBeUndefined();
    expect(conv.url("/events.integrity")).toBeUndefined();
    expect(conv.shareUrl("https://x")).toBeUndefined();
    // The key exists for React and selection, and is not a server id.
    expect(conv.key).toBe(key);
  });

  it("once created, every address uses the SERVER id", async () => {
    for (const s of [...sessionStore.get().sessions]) sessionStore.deleteSession(s.id);
    const key = sessionStore.get().currentId;
    setConversationMinter(async () => "real-server-id");
    await sessionStore.ensureCurrentCreated();

    const conv = conversationFor(sessionStore.current());
    expect(conv.url("/tail")).toContain("/conversations/real-server-id/tail");
    expect(conv.shareUrl("https://x")).toBe("https://x/?thread=real-server-id");
    expect(conv.url("/tail")).not.toContain(key);
    expect(conv.shareUrl("https://x")).not.toContain(key);
  });
});

describe("a bare URL starts on a new conversation (startFresh)", () => {
  it("leaves the server-backed conversation behind and selects an unnamed one", () => {
    sessionStore.mergeFromServer([{ id: "prior", title: "Yesterday's work" }]);
    sessionStore.requestSelect("prior");
    expect(sessionStore.get().currentId).toBe("prior");

    sessionStore.startFresh();
    const { sessions, currentId } = sessionStore.get();
    expect(currentId).not.toBe("prior");
    expect(sessions.find((s) => s.id === currentId)!.title).toBe("New chat");
    // The prior conversation is still listed, just not selected.
    expect(sessions.some((s) => s.id === "prior")).toBe(true);
  });

  it("reuses an untouched conversation rather than stacking another beside it", () => {
    const first = sessionStore.startFresh();
    // The store is a module singleton, so assert the delta of a second bare visit, not a total.
    const rows = sessionStore.get().sessions.length;
    const again = sessionStore.startFresh();
    expect(again).toBe(first);
    expect(sessionStore.get().sessions).toHaveLength(rows);
  });
});
