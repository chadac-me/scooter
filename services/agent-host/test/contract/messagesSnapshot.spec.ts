/** Folding an event log into AG-UI messages for MESSAGES_SNAPSHOT. */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

import { EventType } from "@ag-ui/core";

import { foldToMessages, MESSAGE_EVENTS } from "../../src/agent/messagesSnapshot.js";
import type { AguiEvent } from "../../src/bridge.js";

const ev = (o: Record<string, unknown>) => o as unknown as AguiEvent;

describe("foldToMessages", () => {
  it("concatenates streamed deltas into one message", () => {
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hel" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "lo" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "m1" }),
    ]);
    expect(out).toEqual([{ id: "m1", role: "assistant", content: "Hello" }]);
  });

  it("keeps user and assistant turns distinct, in order", () => {
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hi" }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "hey" }),
    ]);
    expect(out.map((m) => [m.role, m.content])).toEqual([["user", "hi"], ["assistant", "hey"]]);
  });

  it("REASONING becomes a reasoning message — the snapshot carries it, so it is not lost", () => {
    // The applier drops local reasoning when the snapshot carries its own.
    const out = foldToMessages([
      ev({ type: "REASONING_START", messageId: "r1" }),
      ev({ type: "REASONING_MESSAGE_CONTENT", messageId: "r1", delta: "thinking" }),
      ev({ type: "REASONING_MESSAGE_END", messageId: "r1" }),
    ]);
    expect(out).toEqual([{ id: "r1", role: "reasoning", content: "thinking" }]);
  });

  it("a tool call attaches to its assistant message, and its result is a tool message", () => {
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "running it" }),
      ev({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" }),
      ev({ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"cmd":"ls"}' }),
      ev({ type: "TOOL_CALL_END", toolCallId: "t1" }),
      ev({ type: "TOOL_CALL_RESULT", toolCallId: "t1", content: "a.txt" }),
    ]);
    const asst = out.find((m) => m.id === "a1")!;
    expect(asst.toolCalls).toEqual([
      { id: "t1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
    ]);
    const tool = out.find((m) => m.role === "tool")!;
    expect(tool).toMatchObject({ toolCallId: "t1", content: "a.txt" });
  });

  it("keeps TOOL_CALL_ARGS that arrive AFTER TOOL_CALL_END (the shell shape)", () => {
    // A shell tool's command arrives via terminal/create after the call has been opened and closed.
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "run: echo hi" }),
      ev({ type: "TOOL_CALL_END", toolCallId: "t1" }),
      ev({ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"command":"echo hi"}' }),
      ev({ type: "TOOL_CALL_RESULT", toolCallId: "t1", content: "hi" }),
    ]);
    const asst = out.find((m) => m.id === "a1")!;
    expect(asst.toolCalls?.[0].function.arguments, "the late args were dropped").toBe('{"command":"echo hi"}');
  });

  it("folds streamed arg deltas that straddle TOOL_CALL_END", () => {
    // Deltas after END accumulate rather than replacing the earlier ones.
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" }),
      ev({ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"cmd":' }),
      ev({ type: "TOOL_CALL_END", toolCallId: "t1" }),
      ev({ type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '"ls"}' }),
    ]);
    const asst = out.find((m) => m.id === "a1")!;
    expect(asst.toolCalls?.[0].function.arguments).toBe('{"cmd":"ls"}');
  });

  it("a tool call with no open assistant message still gets a carrier", () => {
    // Otherwise the tool result references a toolCallId the client never saw.
    const out = foldToMessages([
      ev({ type: "TOOL_CALL_START", toolCallId: "t9", toolCallName: "x" }),
      ev({ type: "TOOL_CALL_END", toolCallId: "t9" }),
      ev({ type: "TOOL_CALL_RESULT", toolCallId: "t9", content: "done" }),
    ]);
    expect(out.some((m) => m.role === "assistant" && m.toolCalls?.[0].id === "t9")).toBe(true);
    expect(out.some((m) => m.role === "tool" && m.toolCallId === "t9")).toBe(true);
  });

  it("a RESULT whose START/END are missing entirely still gets a carrier", () => {
    // An interrupted run can truncate mid-call; without a synthesized call the client renders a dangling tool card.
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "x" }),
      ev({ type: "TOOL_CALL_RESULT", toolCallId: "orphan", content: "out" }),
    ]);
    const callIds = new Set(out.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
    expect(callIds.has("orphan")).toBe(true);
  });

  it("CONTENT with no preceding START still lands — losing a turn is the worse failure", () => {
    // A log can begin mid-message after a truncated run or an append read before its START flushed.
    const out = foldToMessages([ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "do not lose me" })]);
    expect(out).toEqual([{ id: "u1", role: "assistant", content: "do not lose me" }]);
  });

  it("drops framing that renders nothing (RUN_*, QUEUE_UPDATED, empty messages)", () => {
    const out = foldToMessages([
      ev({ type: "RUN_STARTED", threadId: "t", runId: "r" }),
      ev({ type: "QUEUE_UPDATED", items: [] }),
      ev({ type: "CONTEXT_USAGE", usedTokens: 1, contextWindow: 2 }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "empty", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "empty" }),
      ev({ type: "RUN_FINISHED", threadId: "t", runId: "r" }),
    ]);
    expect(out).toEqual([]);
  });

  it("THE REAL CONVERSATION: folds 9704 events without losing turns", () => {
    const LOG = "/tmp/claude-1000/-home-chadac-code-github-com-chadac-scooter/b878834b-0733-464c-a5a9-e6f74aa3e41a/scratchpad/events.jsonl";
    if (!existsSync(LOG)) return;
    const events = readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const out = foldToMessages(events);
    expect(out.length).toBeGreaterThan(100);
    // Every tool result must reference a call the snapshot also carries.
    const callIds = new Set(out.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)));
    const orphans = out.filter((m) => m.role === "tool" && !callIds.has(m.toolCallId!));
    expect(orphans, "a tool result with no matching call renders as a dangling card").toEqual([]);
  });
});

describe("MESSAGE_EVENTS", () => {
  it("skips every event the applier deep-clones the message array for", () => {
    // Any event left out of the set puts the per-event clone back.
    const mutates = Object.values(EventType).filter(
      (t) => t !== EventType.MESSAGES_SNAPSHOT && /MESSAGE|REASONING|TOOL_CALL|TEXT|THINKING/.test(t),
    );
    expect(mutates.length).toBeGreaterThan(0);
    expect(mutates.filter((t) => !MESSAGE_EVENTS.has(t))).toEqual([]);
  });

  it("still replays events that carry state no snapshot holds", () => {
    for (const t of ["RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "RUN_RETRYING",
                     "QUEUE_UPDATED", "CONTEXT_USAGE", "SYSTEM_MESSAGE"]) {
      expect(MESSAGE_EVENTS.has(t)).toBe(false);
    }
  });
});

describe("windowed folds agree with the whole-log fold", () => {
  const ev = (o: Record<string, unknown>) => o as unknown as AguiEvent;

  it("ends the assistant turn, so a later tool call does not attach to it", () => {
    // openAssistant is cleared at TEXT_MESSAGE_END.
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "first" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "a1" }),
      ev({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" }),
      ev({ type: "TOOL_CALL_END", toolCallId: "t1" }),
    ]);
    const a1 = out.find((m) => m.id === "a1");
    expect(a1?.toolCalls ?? [], "closed turn must not absorb the later tool call").toEqual([]);
    expect(out.some((m) => (m.toolCalls ?? []).some((c) => c.id === "t1"))).toBe(true);
  });

  it("folds the same messages whether the log is split or whole", () => {
    // Scroll-back paging depends on a page boundary not changing what the fold produces.
    const log = [
      ev({ type: "RUN_STARTED", runId: "r1" }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "one" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "a1" }),
      ev({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" }),
      ev({ type: "TOOL_CALL_END", toolCallId: "t1" }),
      ev({ type: "TOOL_CALL_RESULT", toolCallId: "t1", content: "ok" }),
      ev({ type: "RUN_FINISHED", runId: "r1" }),
      ev({ type: "RUN_STARTED", runId: "r2" }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "a2", role: "assistant" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a2", delta: "two" }),
      ev({ type: "TEXT_MESSAGE_END", messageId: "a2" }),
      ev({ type: "RUN_FINISHED", runId: "r2" }),
    ];
    const whole = foldToMessages(log);
    const cut = log.findIndex((e, i) => i > 0 && e.type === "RUN_STARTED");
    const split = [...foldToMessages(log.slice(0, cut)), ...foldToMessages(log.slice(cut))];
    expect(split.map((m) => m.id)).toEqual(whole.map((m) => m.id));
    expect(split.length).toBe(whole.length);
  });
});

describe("foldToMessages createdAt", () => {
  it("stamps each message with the ts of the event that opened it", () => {
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "u1", role: "user", ts: 1000 }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hi", ts: 1001 }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant", ts: 2000 }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "hey", ts: 2500 }),
    ]);
    expect(out.map((m) => [m.id, m.createdAt])).toEqual([["u1", 1000], ["a1", 2000]]);
  });

  it("omits createdAt when the opening event is unstamped", () => {
    const out = foldToMessages([
      ev({ type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" }),
      ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hi", ts: 1001 }),
    ]);
    expect(out[0]).not.toHaveProperty("createdAt");
  });
});

describe("foldToMessages SYSTEM_MESSAGE anchors", () => {
  it("maps each system message to the folded message it followed (null before any)", () => {
    const anchors = new Map<string, string | null>();
    const out = foldToMessages(
      [
        ev({ type: "SYSTEM_MESSAGE", messageId: "s0", source: "scheduler", text: "spawned" }),
        ev({ type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" }),
        ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hi" }),
        ev({ type: "TEXT_MESSAGE_END", messageId: "u1" }),
        ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
        ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "ok" }),
        ev({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "bash" }),
        ev({ type: "TOOL_CALL_END", toolCallId: "t1" }),
        ev({ type: "TEXT_MESSAGE_END", messageId: "a1" }),
        ev({ type: "SYSTEM_MESSAGE", messageId: "s1", source: "github", text: "PR labeled" }),
      ],
      anchors,
    );
    expect(out.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect([...anchors]).toEqual([["s0", null], ["s1", "a1"]]);
  });

  it("falls back past a message that folded away as empty", () => {
    const anchors = new Map<string, string | null>();
    foldToMessages(
      [
        ev({ type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" }),
        ev({ type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hi" }),
        ev({ type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" }),
        ev({ type: "TEXT_MESSAGE_END", messageId: "a1" }),
        ev({ type: "SYSTEM_MESSAGE", messageId: "s1", source: "github", text: "x" }),
      ],
      anchors,
    );
    expect(anchors.get("s1")).toBe("u1");
  });
});
