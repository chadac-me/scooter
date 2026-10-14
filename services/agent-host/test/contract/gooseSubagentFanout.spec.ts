/**
 * Replays the recorded goose subagent-fanout transcript and asserts the subagent
 * completion path reads goose's real event shapes: lastRunCompleted() sees the
 * RUN_FINISHED and lastAssistantText() extracts the child's final message.
 * The fixture is recorded with `GOOSE_BACKEND=bedrock node test/support/record-transcript.mjs goose subagent-fanout`.
 */

import { describe, it, expect } from "vitest";

import { fixtureExists, loadFixture, type TranscriptEntry } from "../support/transcript.js";
import { lastRunCompleted } from "../../src/session/danglingRun.js";
import { lastAssistantText } from "../../src/agent/subagentTools.js";
import type { AguiEvent } from "../../src/bridge.js";

const SCENARIO = "subagent-fanout";

// The recorder concatenates parent and subagent conversations into one file, each entry tagged with its conversationId.
function eventsByConversation(entries: TranscriptEntry[]): Map<string, AguiEvent[]> {
  const byConv = new Map<string, AguiEvent[]>();
  for (const e of entries) {
    if (e.layer !== "agui-out") continue;
    const conv = (e as { conversationId?: string }).conversationId ?? "?";
    (byConv.get(conv) ?? byConv.set(conv, []).get(conv)!).push(e.data as AguiEvent);
  }
  return byConv;
}

// goose renders the MCP tool name as "Scooter-env: Spawn Subagent"; other paths use "spawn_subagent".
const SPAWN_RE = /spawn[_ ]?subagent/i;
const hasSpawn = (events: AguiEvent[]) =>
  events.some((e) => e.type === "TOOL_CALL_START" && SPAWN_RE.test((e as { toolCallName?: string }).toolCallName ?? ""));

// The fixture is recorded on demand, so skip when it is absent.
const maybe = fixtureExists("goose", SCENARIO) ? describe : describe.skip;

maybe("goose subagent-fanout (real Bedrock transcript)", () => {
  const entries = fixtureExists("goose", SCENARIO) ? loadFixture("goose", SCENARIO) : [];
  const byConv = eventsByConversation(entries);
  const parents = [...byConv.entries()].filter(([, ev]) => hasSpawn(ev));
  const subagents = [...byConv.entries()].filter(([, ev]) => !hasSpawn(ev));

  it("the parent actually spawned subagents (real spawn_subagent tool calls)", () => {
    expect(parents.length).toBe(1);
    const parentSpawns = parents[0][1].filter(
      (e) => e.type === "TOOL_CALL_START" && SPAWN_RE.test((e as { toolCallName?: string }).toolCallName ?? ""),
    );
    expect(parentSpawns.length).toBeGreaterThanOrEqual(2);
  });

  it("every subagent's run COMPLETED (lastRunCompleted sees a real goose RUN_FINISHED)", () => {
    expect(subagents.length).toBeGreaterThanOrEqual(2);
    for (const [, ev] of subagents) {
      expect(lastRunCompleted(ev)).toBe(true);
    }
  });

  it("every subagent yields a non-empty result (lastAssistantText extracts goose's final message)", () => {
    // On real goose the final turn is a plain assistant text message.
    for (const [conv, ev] of subagents) {
      const result = lastAssistantText(ev);
      expect(result, `subagent ${conv} produced no extractable final text`).toBeTruthy();
      expect((result ?? "").length).toBeGreaterThan(0);
    }
  });
});
