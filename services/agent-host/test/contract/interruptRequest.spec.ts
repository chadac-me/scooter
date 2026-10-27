/**
 * Contrib-rendered requests through the bridge: a permission request carrying `request`
 * pauses the run with its kind and data in the interrupt's metadata, and the user's result
 * object reaches the agent alongside the chosen option.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge, type AguiEvent } from "../../src/bridge.js";
import type { AcpClient, PermissionAnswer, PermissionRequest } from "../../src/acp/client.js";
import { interruptResult } from "../../src/agui/server.js";
import { parseBlockingTools } from "../../src/agent/blockingTools.js";
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
  request: { kind: "ask-user.questions", data: { questions: QUESTIONS } },
};

describe("a contrib request over the bridge", () => {
  it("raises an interrupt carrying its kind and data, and hands the result to the agent @proves", async () => {
    const { client, answers } = askingClient(ASK);
    const bridge = bridgeFor(client);
    const interrupts: AguiEvent[] = [];
    bridge.onEvent((e) => {
      if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
        interrupts.push(e);
        const intr = e.outcome.interrupts[0];
        bridge.answerPermission(intr.id, "answer", undefined, { answers: { [QUESTIONS[0].question]: "Postgres" } });
      }
    });

    await bridge.prompt({ threadId: "t1", text: "set up the db" });

    expect(interrupts).toHaveLength(1);
    const intr = (interrupts[0] as Extract<AguiEvent, { type: "RUN_FINISHED" }>).outcome as {
      interrupts: Array<{ reason: string; metadata?: Record<string, unknown> }>;
    };
    expect(intr.interrupts[0].reason).toBe("confirmation");
    expect(intr.interrupts[0].metadata).toMatchObject({ kind: "ask-user.questions", data: { questions: QUESTIONS } });
    expect(answers).toEqual([{ optionId: "answer", result: { answers: { "Which database should we use?": "Postgres" } } }]);
  });

  it("a dismissed request reaches the agent as a cancel, with no result", async () => {
    const { client, answers } = askingClient(ASK);
    const bridge = bridgeFor(client);
    bridge.onEvent((e) => {
      if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
        bridge.answerPermission(e.outcome.interrupts[0].id, "", undefined, { answers: { ignored: "x" } });
      }
    });
    await bridge.prompt({ threadId: "t1", text: "go" });
    expect(answers).toEqual([{ cancelled: true }]);
  });

  it("oversized data falls back to a plain choice with no kind", async () => {
    const { client } = askingClient({ ...ASK, request: { kind: "ask-user.questions", data: { blob: "x".repeat(70_000) } } });
    const bridge = bridgeFor(client);
    let metadata: Record<string, unknown> | undefined;
    bridge.onEvent((e) => {
      if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
        metadata = e.outcome.interrupts[0].metadata as Record<string, unknown>;
        bridge.answerPermission(e.outcome.interrupts[0].id, "");
      }
    });
    await bridge.prompt({ threadId: "t1", text: "go" });
    expect(metadata).toEqual({ options: ASK.options });
  });

  it("a plain approval carries no kind and no result", async () => {
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

describe("interruptResult (resume payload)", () => {
  it("is the payload's result object", () => {
    expect(interruptResult({ optionId: "answer", result: { answers: { a: "x" } } })).toEqual({ answers: { a: "x" } });
  });
  it("is undefined for a payload with no object result", () => {
    expect(interruptResult(undefined)).toBeUndefined();
    expect(interruptResult({ optionId: "allow" })).toBeUndefined();
    expect(interruptResult({ result: ["x"] })).toBeUndefined();
    expect(interruptResult({ result: "x" })).toBeUndefined();
  });
  it("drops a result over the size cap", () => {
    expect(interruptResult({ result: { a: "y".repeat(20_000) } })).toBeUndefined();
  });
});

describe("parseBlockingTools (BLOCKING_TOOLS_JSON)", () => {
  const row = { kind: "ask-user.questions", title: "A question", dismissed: "Dismissed." };
  it("keeps well-formed rows and drops malformed ones", () => {
    const warn: string[] = [];
    const raw = JSON.stringify({ AskUserQuestion: row, Bad: { kind: "" }, Worse: 3 });
    expect(parseBlockingTools(raw, (m) => warn.push(m))).toEqual({ AskUserQuestion: row });
    expect(warn).toHaveLength(2);
  });
  it("is empty when unset or not JSON", () => {
    expect(parseBlockingTools(undefined)).toEqual({});
    expect(parseBlockingTools("{nope")).toEqual({});
    expect(parseBlockingTools("[]")).toEqual({});
  });
});

describe("blocking tools reach the provider", () => {
  it("newSession is offered the configured blockingTools", async () => {
    const { client } = askingClient({ toolCallId: "p", title: "t", options: [] });
    let seen: unknown;
    const newSession = client.newSession.bind(client);
    client.newSession = async (p) => {
      seen = p.blockingTools;
      return newSession(p);
    };
    client.prompt = async () => ({ stopReason: "end_turn" });
    const blockingTools = { AskUserQuestion: { kind: "ask-user.questions", title: "Q", dismissed: "D" } };
    const bridge = createSessionBridge({
      config: {
        cwd: "/workspace",
        skillsDir: "/skills",
        blockingTools,
        agent: { command: "fake", args: [], env: {} },
        sandbox: { name: "s", namespace: "ns" },
      },
      exec: createSandboxExecBackend(createFakeSandboxApi()),
      acpClient: client,
    });
    await bridge.prompt({ threadId: "t1", text: "go" });
    expect(seen).toEqual(blockingTools);
  });
});
