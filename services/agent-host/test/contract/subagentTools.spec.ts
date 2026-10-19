/**
 * The subagent MCP tool handlers (spawn, list, check, cancel, send, monitor, search),
 * pure handlers over the SubagentManager seam so they are testable without a real
 * bridge or pod.
 */

import { describe, it, expect, vi } from "vitest";

import {
  handleSpawnSubagent,
  handleListSubagents,
  handleCheckSubagent,
  handleCancelSubagent,
  handleSendToSubagent,
  handleMonitorSubagent,
  handleSearchSubagent,
  lastAssistantText,
  subagentDoneNotice,
  SubagentLimitError,
  type SubagentManager,
} from "../../src/agent/subagentTools.js";
import type { AguiEvent } from "../../src/bridge.js";

const fakeManager = (over: Partial<SubagentManager> = {}): SubagentManager => ({
  spawn: vi.fn(async (_parentId, args) => ({ id: `sub-${args.prompt.slice(0, 3)}`, title: args.title })),
  list: vi.fn(async () => [
    { id: "sub-a", title: "research A", status: "running" },
    { id: "sub-b", title: "research B", status: "ended" },
  ]),
  check: vi.fn(async (_parentId, id) => ({ id, status: "running", lastActivity: "working on it" })),
  cancel: vi.fn(async () => ({ outcome: "cancelled" })),
  send: vi.fn(async () => ({ outcome: "sent" })),
  recentTurns: vi.fn(async () => [
    { role: "user", text: "find the auth bug" },
    { role: "tool", text: "ran bash `grep -r auth`" },
    { role: "assistant", text: "checking auth.ts" },
  ]),
  searchHistory: vi.fn(async () => [{ role: "assistant", text: "the auth bug is in login()" }]),
  ...over,
});

const PARENT = "conv-parent";

describe("subagent tools", () => {
  it("spawn_subagent starts a child + returns its id with a poll hint", async () => {
    const mgr = fakeManager();
    const out = await handleSpawnSubagent(mgr, PARENT, { prompt: "research the API" });
    expect(out.isError).toBeFalsy();
    expect(mgr.spawn).toHaveBeenCalledWith(PARENT, { prompt: "research the API" });
    const text = out.content[0].text;
    expect(text).toContain("sub-res");
    expect(text).toMatch(/check_subagent/i);
  });

  it("spawn_subagent surfaces a limit refusal as a tool error the model can act on", async () => {
    const mgr = fakeManager({ spawn: vi.fn(async () => { throw new SubagentLimitError("Not spawned: limit 4"); }) });
    const out = await handleSpawnSubagent(mgr, PARENT, { prompt: "research the API" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe("Not spawned: limit 4");
  });

  it("spawn_subagent errors on an empty prompt (no child started)", async () => {
    const mgr = fakeManager();
    const out = await handleSpawnSubagent(mgr, PARENT, { prompt: "   " });
    expect(out.isError).toBe(true);
    expect(mgr.spawn).not.toHaveBeenCalled();
  });

  it("list_subagents lists this conversation's children + statuses", async () => {
    const mgr = fakeManager();
    const out = await handleListSubagents(mgr, PARENT);
    expect(mgr.list).toHaveBeenCalledWith(PARENT);
    expect(out.content[0].text).toContain("sub-a");
    expect(out.content[0].text).toContain("sub-b");
  });

  it("check_subagent reports status + last activity", async () => {
    const mgr = fakeManager();
    const out = await handleCheckSubagent(mgr, PARENT, { subagent_id: "sub-a" });
    expect(mgr.check).toHaveBeenCalledWith(PARENT, "sub-a");
    expect(out.content[0].text).toMatch(/running/i);
  });

  it("check_subagent tells a RUNNING subagent's poller to STOP polling + end its turn", async () => {
    // A busy check_subagent poll loop keeps the parent busy, so the event-driven result cannot land.
    const mgr = fakeManager({ check: vi.fn(async (_p, id) => ({ id, status: "running", lastActivity: "x" })) });
    const out = await handleCheckSubagent(mgr, PARENT, { subagent_id: "sub-a" });
    expect(out.content[0].text).toMatch(/end your turn|do not (keep )?poll|you'?ll be (told|notified)/i);
  });

  it("check_subagent does NOT tell a finished subagent's poller to wait", async () => {
    const mgr = fakeManager({ check: vi.fn(async (_p, id) => ({ id, status: "ended", lastActivity: "the result" })) });
    const out = await handleCheckSubagent(mgr, PARENT, { subagent_id: "sub-a" });
    expect(out.content[0].text).not.toMatch(/end your turn|do not (keep )?poll/i);
  });

  it("check_subagent errors on a missing id", async () => {
    const out = await handleCheckSubagent(fakeManager(), PARENT, { subagent_id: "" });
    expect(out.isError).toBe(true);
  });

  it("check_subagent errors when the child isn't a child of THIS conversation", async () => {
    // The manager returns undefined for a foreign or unknown id.
    const mgr = fakeManager({ check: vi.fn(async () => undefined) });
    const out = await handleCheckSubagent(mgr, PARENT, { subagent_id: "sub-foreign" });
    expect(out.isError).toBe(true);
  });

  it("cancel_subagent stops the child's run", async () => {
    const mgr = fakeManager();
    const out = await handleCancelSubagent(mgr, PARENT, { subagent_id: "sub-a" });
    expect(mgr.cancel).toHaveBeenCalledWith(PARENT, "sub-a");
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/cancel/i);
  });

  // --- send_to_subagent (clarify a running child) ---

  it("send_to_subagent forwards the clarification to a running child", async () => {
    const mgr = fakeManager();
    const out = await handleSendToSubagent(mgr, PARENT, { subagent_id: "sub-a", message: "focus on login()" });
    expect(mgr.send).toHaveBeenCalledWith(PARENT, "sub-a", "focus on login()");
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/interrupt|clarification/i);
  });

  it("send_to_subagent FAILS when the child isn't running (nothing to clarify)", async () => {
    const mgr = fakeManager({ send: vi.fn(async () => ({ outcome: "not-running" })) });
    const out = await handleSendToSubagent(mgr, PARENT, { subagent_id: "sub-a", message: "hey" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/isn't running|not running/i);
  });

  it("send_to_subagent errors for a non-child (scoping) and for an empty message", async () => {
    const mgr = fakeManager({ send: vi.fn(async () => ({ outcome: "unknown" })) });
    expect((await handleSendToSubagent(mgr, PARENT, { subagent_id: "foreign", message: "x" })).isError).toBe(true);
    expect((await handleSendToSubagent(fakeManager(), PARENT, { subagent_id: "sub-a", message: "  " })).isError).toBe(true);
  });

  // --- monitor_subagent (recent turns) ---

  it("monitor_subagent renders recent turns (text + tool summaries)", async () => {
    const mgr = fakeManager();
    const out = await handleMonitorSubagent(mgr, PARENT, { subagent_id: "sub-a", turns: 5 });
    expect(mgr.recentTurns).toHaveBeenCalledWith(PARENT, "sub-a", 5);
    expect(out.isError).toBeFalsy();
    const text = out.content[0].text;
    expect(text).toContain("find the auth bug");
    expect(text).toContain("grep -r auth");
    expect(text).toContain("checking auth.ts");
  });

  it("monitor_subagent clamps turns to the max and defaults when unspecified", async () => {
    const mgr = fakeManager();
    await handleMonitorSubagent(mgr, PARENT, { subagent_id: "sub-a", turns: 999 });
    expect(mgr.recentTurns).toHaveBeenCalledWith(PARENT, "sub-a", 30);
    await handleMonitorSubagent(mgr, PARENT, { subagent_id: "sub-a" });
    expect(mgr.recentTurns).toHaveBeenLastCalledWith(PARENT, "sub-a", 6);
  });

  it("monitor_subagent errors for a non-child; friendly note when no messages yet", async () => {
    expect((await handleMonitorSubagent(fakeManager({ recentTurns: vi.fn(async () => undefined) }), PARENT, { subagent_id: "foreign" })).isError).toBe(true);
    const empty = await handleMonitorSubagent(fakeManager({ recentTurns: vi.fn(async () => []) }), PARENT, { subagent_id: "sub-a" });
    expect(empty.isError).toBeFalsy();
    expect(empty.content[0].text).toMatch(/no messages/i);
  });

  // --- search_subagent (history) ---

  it("search_subagent returns matching turns", async () => {
    const mgr = fakeManager();
    const out = await handleSearchSubagent(mgr, PARENT, { subagent_id: "sub-a", query: "auth bug" });
    expect(mgr.searchHistory).toHaveBeenCalledWith(PARENT, "sub-a", "auth bug");
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toContain("login()");
  });

  it("search_subagent errors for a non-child / empty query; friendly no-match message", async () => {
    expect((await handleSearchSubagent(fakeManager({ searchHistory: vi.fn(async () => undefined) }), PARENT, { subagent_id: "foreign", query: "x" })).isError).toBe(true);
    expect((await handleSearchSubagent(fakeManager(), PARENT, { subagent_id: "sub-a", query: "  " })).isError).toBe(true);
    const none = await handleSearchSubagent(fakeManager({ searchHistory: vi.fn(async () => []) }), PARENT, { subagent_id: "sub-a", query: "zzz" });
    expect(none.isError).toBeFalsy();
    expect(none.content[0].text).toMatch(/no turns.*match/i);
  });
});

// The completion-watcher building blocks: the result is the last assistant message.
describe("subagent completion (last-message result)", () => {
  const t = (id: string, role: "assistant" | "user", text: string): AguiEvent[] => [
    { type: "TEXT_MESSAGE_START", messageId: id, role },
    { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text },
    { type: "TEXT_MESSAGE_END", messageId: id },
  ];

  it("lastAssistantText concatenates the LAST assistant message's deltas", () => {
    const events: AguiEvent[] = [
      ...t("u1", "user", "do the thing"),
      ...t("a1", "assistant", "working"),
      ...t("a2", "assistant", "I found "),
      { type: "TEXT_MESSAGE_START", messageId: "a2b", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a2b", delta: "the bug" },
      { type: "TEXT_MESSAGE_END", messageId: "a2b" },
    ];
    expect(lastAssistantText(events)).toBe("the bug");
  });

  it("lastAssistantText ignores user messages + returns undefined when none", () => {
    expect(lastAssistantText([...t("u1", "user", "hi")])).toBeUndefined();
    expect(lastAssistantText([])).toBeUndefined();
  });

  it("subagentDoneNotice frames the child's result for injection into the parent", () => {
    const text = subagentDoneNotice("sub-a", "research A", "found 3 issues");
    expect(text).toContain("sub-a");
    expect(text).toContain("research A");
    expect(text).toContain("found 3 issues");
  });

  it("subagentDoneNotice handles a subagent that reported no final text", () => {
    const text = subagentDoneNotice("sub-a", "research A", undefined);
    expect(text).toContain("sub-a");
    expect(text).toMatch(/no (result|final)/i);
  });
});
