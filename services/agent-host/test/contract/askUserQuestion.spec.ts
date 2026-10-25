/**
 * AskUserQuestion through the bridge: a permission request carrying `questions` pauses the
 * run as an "input_required" interrupt with the questions in its metadata, and the user's
 * answers reach the agent alongside the chosen option.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge, type AguiEvent } from "../../src/bridge.js";
import type { AcpClient, PermissionAnswer, PermissionRequest } from "../../src/acp/client.js";
import { questionAnswers } from "../../src/agui/server.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";

const QUESTIONS = [
  {
    question: "Which database should we use?",
    header: "Database",
    options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite" }],
  },
];

/** A client whose turn asks `req` and records the answer it got back. */
function askingClient(req: Omit<PermissionRequest, "sessionId">) {
  let handler: ((r: PermissionRequest) => Promise<PermissionAnswer>) | undefined;
  const answers: PermissionAnswer[] = [];
  const client: AcpClient = {
    async initialize() {
      return { protocolVersion: 1 };
    },
    async newSession() {
      return { sessionId: "sess-1" };
    },
    async prompt() {
      answers.push(await handler!({ sessionId: "sess-1", ...req }));
      return { stopReason: "end_turn" };
    },
    async cancel() {},
    async killActiveTerminals() {},
    onSessionUpdate() {
      return () => {};
    },
    onTerminalCreated() {
      return () => {};
    },
    onPermissionRequest(h) {
      handler = h;
    },
    isAlive: () => true,
    async close() {},
  };
  return { client, answers };
}

const bridgeFor = (client: AcpClient) =>
  createSessionBridge({
    config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
    exec: createSandboxExecBackend(createFakeSandboxApi()),
    acpClient: client,
  });

const ASK = {
  toolCallId: "toolu_1",
  title: "Which database should we use?",
  options: [{ optionId: "answer", name: "Answer", kind: "allow_once" }],
  questions: QUESTIONS,
};

describe("AskUserQuestion over the bridge", () => {
  it("raises an input_required interrupt carrying the questions, and hands the answers to the agent @proves", async () => {
    const { client, answers } = askingClient(ASK);
    const bridge = bridgeFor(client);
    const interrupts: AguiEvent[] = [];
    bridge.onEvent((e) => {
      if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
        interrupts.push(e);
        const intr = e.outcome.interrupts[0];
        bridge.answerPermission(intr.id, "answer", undefined, { [QUESTIONS[0].question]: "Postgres" });
      }
    });

    await bridge.prompt({ threadId: "t1", text: "set up the db" });

    expect(interrupts).toHaveLength(1);
    const intr = (interrupts[0] as Extract<AguiEvent, { type: "RUN_FINISHED" }>).outcome as {
      interrupts: Array<{ reason: string; metadata?: Record<string, unknown> }>;
    };
    expect(intr.interrupts[0].reason).toBe("input_required");
    expect(intr.interrupts[0].metadata?.questions).toEqual(QUESTIONS);
    expect(answers).toEqual([{ optionId: "answer", answers: { "Which database should we use?": "Postgres" } }]);
  });

  it("a dismissed question reaches the agent as a cancel, with no answers", async () => {
    const { client, answers } = askingClient(ASK);
    const bridge = bridgeFor(client);
    bridge.onEvent((e) => {
      if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
        bridge.answerPermission(e.outcome.interrupts[0].id, "", undefined, { ignored: "x" });
      }
    });
    await bridge.prompt({ threadId: "t1", text: "go" });
    expect(answers).toEqual([{ cancelled: true }]);
  });

  it("a plain approval stays a confirmation and carries no answers", async () => {
    const { client, answers } = askingClient({
      toolCallId: "perm1",
      title: "Allow?",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    const bridge = bridgeFor(client);
    let reason: string | undefined;
    bridge.onEvent((e) => {
      if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
        reason = e.outcome.interrupts[0].reason;
        bridge.answerPermission(e.outcome.interrupts[0].id, "allow");
      }
    });
    await bridge.prompt({ threadId: "t1", text: "go" });
    expect(reason).toBe("confirmation");
    expect(answers).toEqual([{ optionId: "allow" }]);
  });
});

describe("questionAnswers (resume payload)", () => {
  it("keeps string answers and drops everything else", () => {
    expect(questionAnswers({ optionId: "answer", answers: { a: "x", b: 3, c: "", d: "  " } })).toEqual({ a: "x" });
  });
  it("is undefined for a payload with no usable answers", () => {
    expect(questionAnswers(undefined)).toBeUndefined();
    expect(questionAnswers({ optionId: "allow" })).toBeUndefined();
    expect(questionAnswers({ answers: ["x"] })).toBeUndefined();
    expect(questionAnswers({ answers: { a: 1 } })).toBeUndefined();
  });
  it("bounds the number and length of answers", () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, "y".repeat(10_000)]));
    const out = questionAnswers({ answers: many })!;
    expect(Object.keys(out)).toHaveLength(8);
    expect(out.q0).toHaveLength(4000);
  });
});
