/**
 * Blocking tools: for a tool newSession names in `blockingTools`, the PreToolUse hook sends its
 * input as a request of the tool's kind, blocks on the bridge's permission handler, and merges
 * the user's result into updatedInput, the shape the CLI accepts in place of its own prompt.
 */

import { describe, it, expect } from "vitest";

import { createSdkAcpClient } from "./sdkClient.js";
import { BLOCKING_TOOL_TIMEOUT_S } from "./blockingToolHook.js";
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

const ASK = { kind: "ask-user.questions", title: "The agent has a question", dismissed: "The user dismissed it; proceed." };

type Hook = (input: unknown, toolUseId?: string, opts?: { signal?: AbortSignal }) => Promise<any>;

/** One turn's PreToolUse matcher, with the client's permission handler set to `answer`. */
async function setup(
  answer?: (req: PermissionRequest) => Promise<PermissionAnswer>,
  blockingTools: Record<string, typeof ASK> = { AskUserQuestion: ASK },
) {
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
  await client.newSession({ cwd: "/", blockingTools });
  await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);
  const matcher = (options.hooks as { PreToolUse: Array<{ timeout?: number; hooks: Hook[] }> }).PreToolUse[0];
  return { matcher, hook: matcher.hooks[0], asked };
}

describe("blocking tool hook", () => {
  it("sends the input as a request of the tool's kind and merges the result into updatedInput @proves", async () => {
    const result = { answers: { "Which database?": "Postgres" } };
    const { hook, asked } = await setup(async () => ({ optionId: "answer", result }));
    const out = await hook({ tool_name: "AskUserQuestion", tool_input: INPUT }, "toolu_9");

    expect(asked).toHaveLength(1);
    expect(asked[0].toolCallId).toBe("toolu_9");
    expect(asked[0].request).toEqual({ kind: "ask-user.questions", data: INPUT });
    expect(asked[0].title).toBe(ASK.title);
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...INPUT, answers: { "Which database?": "Postgres" } },
    });
  });

  it("a dismissed request is denied with the tool's dismissed message", async () => {
    const { hook } = await setup(async () => ({ cancelled: true }));
    const out = await hook({ tool_name: "AskUserQuestion", tool_input: INPUT }, "toolu_1");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(ASK.dismissed);
  });

  it("an aborted turn stops waiting", async () => {
    const { hook } = await setup(() => new Promise(() => {}));
    const ac = new AbortController();
    const pending = hook({ tool_name: "AskUserQuestion", tool_input: INPUT }, "toolu_1", { signal: ac.signal });
    ac.abort();
    expect((await pending).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("an answer with no result counts as dismissed", async () => {
    const { hook } = await setup(async () => ({ optionId: "answer" }));
    const out = await hook({ tool_name: "AskUserQuestion", tool_input: INPUT }, "toolu_1");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(ASK.dismissed);
  });

  it("the matcher's timeout outlasts a human answering @proves", async () => {
    // The CLI's default hook timeout would cancel the question long before a person replies.
    const { matcher } = await setup(async () => ({ cancelled: true }));
    expect(matcher.timeout).toBe(BLOCKING_TOOL_TIMEOUT_S);
    expect(BLOCKING_TOOL_TIMEOUT_S).toBeGreaterThanOrEqual(24 * 60 * 60);
  });

  it("with no permission handler, falls back to the state-it-in-your-reply redirect", async () => {
    const { hook } = await setup();
    const out = await hook({ tool_name: "AskUserQuestion", tool_input: INPUT }, "toolu_1");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/state the question/i);
  });

  it("without the ask-user row, AskUserQuestion falls back to the state-it-in-your-reply redirect", async () => {
    const { hook, asked } = await setup(async () => ({ cancelled: true }), {});
    const out = await hook({ tool_name: "AskUserQuestion", tool_input: INPUT }, "toolu_1");
    expect(asked).toHaveLength(0);
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/state the question/i);
  });

  it("any tool a contrib names blocks the same way, under its own kind", async () => {
    const pick = { kind: "files.pick", title: "Pick a file", dismissed: "No file picked." };
    const { hook, asked } = await setup(async () => ({ optionId: "answer", result: { path: "a.txt" } }), { PickFile: pick });
    const out = await hook({ tool_name: "PickFile", tool_input: { glob: "*.txt" } }, "t");
    expect(asked[0].request).toEqual({ kind: "files.pick", data: { glob: "*.txt" } });
    expect(out.hookSpecificOutput.updatedInput).toEqual({ glob: "*.txt", path: "a.txt" });
  });

  it("other tools are unaffected by the blocking path", async () => {
    const { hook, asked } = await setup(async () => ({ cancelled: true }));
    expect(await hook({ tool_name: "TodoWrite", tool_input: {} }, "t")).toEqual({ continue: true });
    expect(asked).toHaveLength(0);
  });
});
