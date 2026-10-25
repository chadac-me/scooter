/**
 * AskUserQuestion: the PreToolUse hook blocks on the bridge's permission handler and returns the
 * user's answers as updatedInput, the shape the CLI accepts in place of its own prompt.
 */

import { describe, it, expect } from "vitest";

import { createSdkAcpClient } from "./sdkClient.js";
import { ASK_USER_TIMEOUT_S, parseQuestions } from "./askUser.js";
import type { ExecBackend, PermissionAnswer, PermissionRequest } from "./types.js";

const fakeExec = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
} as unknown as ExecBackend;

const INPUT = {
  questions: [
    {
      question: "Which database?",
      header: "DB",
      options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite", description: "Embedded" }],
      multiSelect: false,
    },
  ],
};

type Hook = (input: unknown, toolUseId?: string, opts?: { signal?: AbortSignal }) => Promise<any>;

/** One turn's PreToolUse matcher, with the client's permission handler set to `answer`. */
async function setup(answer?: (req: PermissionRequest) => Promise<PermissionAnswer>) {
  let options: Record<string, unknown> = {};
  const queryImpl = (p: { options: Record<string, unknown> }) => {
    options = p.options;
    async function* gen() {
      yield { type: "result", subtype: "success", session_id: "s" } as never;
    }
    return Object.assign(gen(), { interrupt: async () => {} });
  };
  const client = await createSdkAcpClient({ oauthToken: "t", model: "m", exec: fakeExec, systemPrompt: "", queryImpl });
  const asked: PermissionRequest[] = [];
  if (answer) client.onPermissionRequest(async (r) => (asked.push(r), answer(r)));
  await client.newSession({} as never);
  await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);
  const matcher = (options.hooks as { PreToolUse: Array<{ timeout?: number; hooks: Hook[] }> }).PreToolUse[0];
  return { matcher, hook: matcher.hooks[0], asked };
}

describe("AskUserQuestion hook", () => {
  it("asks the user and returns the answers as updatedInput @proves", async () => {
    const { hook, asked } = await setup(async () => ({ optionId: "answer", answers: { "Which database?": "Postgres" } }));
    const out = await hook({ tool_name: "AskUserQuestion", tool_input: INPUT }, "toolu_9");

    expect(asked).toHaveLength(1);
    expect(asked[0].toolCallId).toBe("toolu_9");
    expect(asked[0].questions?.[0].question).toBe("Which database?");
    expect(asked[0].title).toBe("Which database?");
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...INPUT, answers: { "Which database?": "Postgres" } },
    });
  });

  it("a dismissed question is denied with an instruction to proceed", async () => {
    const { hook } = await setup(async () => ({ cancelled: true }));
    const out = await hook({ tool_name: "AskUserQuestion", tool_input: INPUT }, "toolu_1");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/dismissed/i);
  });

  it("an aborted turn stops waiting", async () => {
    const { hook } = await setup(() => new Promise(() => {}));
    const ac = new AbortController();
    const pending = hook({ tool_name: "AskUserQuestion", tool_input: INPUT }, "toolu_1", { signal: ac.signal });
    ac.abort();
    expect((await pending).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("malformed input is denied without asking", async () => {
    const { hook, asked } = await setup(async () => ({ optionId: "answer", answers: { x: "y" } }));
    const out = await hook({ tool_name: "AskUserQuestion", tool_input: { questions: [] } }, "toolu_1");
    expect(asked).toHaveLength(0);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("the matcher's timeout outlasts a human answering @proves", async () => {
    // The CLI's default hook timeout would cancel the question long before a person replies.
    const { matcher } = await setup(async () => ({ cancelled: true }));
    expect(matcher.timeout).toBe(ASK_USER_TIMEOUT_S);
    expect(ASK_USER_TIMEOUT_S).toBeGreaterThanOrEqual(24 * 60 * 60);
  });

  it("with no permission handler, falls back to the state-it-in-your-reply redirect", async () => {
    const { hook } = await setup();
    const out = await hook({ tool_name: "AskUserQuestion", tool_input: INPUT }, "toolu_1");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/state the question/i);
  });

  it("other tools are unaffected by the question path", async () => {
    const { hook, asked } = await setup(async () => ({ cancelled: true }));
    expect(await hook({ tool_name: "TodoWrite", tool_input: {} }, "t")).toEqual({ continue: true });
    expect(asked).toHaveLength(0);
  });
});

describe("parseQuestions", () => {
  it("keeps the fields the UI renders and drops label-less options", () => {
    expect(
      parseQuestions({ questions: [{ question: "Q?", header: "H", options: [{ label: "a", preview: "p" }, { nope: 1 }], multiSelect: true }] }),
    ).toEqual([{ question: "Q?", header: "H", options: [{ label: "a", preview: "p" }], multiSelect: true }]);
  });
  it("rejects input with no questions or a question with no options", () => {
    expect(parseQuestions(undefined)).toBeUndefined();
    expect(parseQuestions({ questions: [] })).toBeUndefined();
    expect(parseQuestions({ questions: [{ question: "Q?", options: [] }] })).toBeUndefined();
  });
});
