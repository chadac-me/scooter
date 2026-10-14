/**
 * Tier 1 replay: drive the real sdkClient with recorded claude messages, so the test
 * runs against the exact shapes the SDK emits rather than a hand-authored fake.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createSdkAcpClient } from "./sdkClient.js";
import type { ExecBackend, SessionUpdate } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Fixtures live in agent-host's test tree, which owns the recorder.
const fixture = (scenario: string) => join(HERE, `../../agent-host/test/fixtures/transcripts/claude/${scenario}.ndjson`);

const fakeExec: ExecBackend = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  createTerminal: async () => ({ id: "t", write: async () => {}, kill: async () => {}, output: async () => "" }),
} as unknown as ExecBackend;

/** The raw recorded SDK messages for a scenario, in order. */
function recordedSdkMessages(scenario = "subagent-poll-loop"): unknown[] {
  return readFileSync(fixture(scenario), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e: { layer: string }) => e.layer === "sdk-in")
    .map((e: { data: unknown }) => e.data);
}

/** A fake query() that yields the recorded messages verbatim, honoring interrupt(). */
function replayQuery(messages: unknown[]) {
  let interrupted = false;
  const queryImpl = () => {
    async function* gen() {
      for (const msg of messages) {
        if (interrupted) return;
        yield msg as never;
        await Promise.resolve();
      }
    }
    return Object.assign(gen(), { interrupt: async () => { interrupted = true; } });
  };
  return { queryImpl, wasInterrupted: () => interrupted };
}

describe("REPLAY: real claude transcript (subagent-poll-loop)", () => {
  it("GROUND TRUTH: the SDK sends tool_result in a `user` message, not `assistant`", () => {
    const msgs = recordedSdkMessages() as Array<{ type?: string; message?: { content?: Array<{ type?: string }> } }>;
    const toolResults = msgs.filter((m) => m.message?.content?.some((b) => b.type === "tool_result"));
    expect(toolResults.length).toBeGreaterThan(0);
    // Every tool_result rides a `user` message.
    expect(toolResults.every((m) => m.type === "user")).toBe(true);
  });

  it("the emitted updates carry each tool CALL (tool_use -> tool_call) from the real stream", async () => {
    const updates: SessionUpdate[] = [];
    const rq = replayQuery(recordedSdkMessages());
    const client = await createSdkAcpClient({ oauthToken: "t", model: "claude-opus-4-8", exec: fakeExec, systemPrompt: "hi", queryImpl: rq.queryImpl });
    client.onSessionUpdate((_id, u) => updates.push(u));
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "poll" }] } as never);

    const toolCalls = updates.filter((u) => u.sessionUpdate === "tool_call");
    expect(toolCalls.length).toBeGreaterThan(0);
  });

  it("REGRESSION: back-pressure yields when shouldYield() is true — keyed on the tool CALL", async () => {
    // With shouldYield() true, replaying the real stream ends by breaking at the tool call, not by interrupting.
    const rq = replayQuery(recordedSdkMessages());
    const client = await createSdkAcpClient({
      oauthToken: "t", model: "claude-opus-4-8", exec: fakeExec, systemPrompt: "hi",
      queryImpl: rq.queryImpl, shouldYield: () => true,
    });
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "poll" }] } as never);
    expect(rq.wasInterrupted()).toBe(false);
  });

  it("FIX: the tool RESULT now surfaces (tool_call_update) — a `user`-message tool_result is no longer dropped", async () => {
    // A recorded `echo HARNESS_MARKER` run whose result rides a `user` message.
    const updates: SessionUpdate[] = [];
    const rq = replayQuery(recordedSdkMessages("shell-tool-and-result"));
    const client = await createSdkAcpClient({ oauthToken: "t", model: "claude-opus-4-8", exec: fakeExec, systemPrompt: "hi", queryImpl: rq.queryImpl });
    client.onSessionUpdate((_id, u) => updates.push(u));
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "run echo" }] } as never);

    const results = updates.filter((u) => u.sessionUpdate === "tool_call_update");
    expect(results.length).toBeGreaterThan(0);
    expect(JSON.stringify(results)).toContain("HARNESS_MARKER");
  });
});
