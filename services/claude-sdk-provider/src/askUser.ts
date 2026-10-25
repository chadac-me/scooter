/**
 * AskUserQuestion over the bridge's permission flow. The PreToolUse hook blocks on the
 * user's answer and returns it as `updatedInput.answers`, which the CLI accepts as the
 * tool's user interaction (dontAsk mode would deny the tool before canUseTool ever ran).
 */

import type { PermissionAnswer, PermissionRequest, UserQuestion } from "./types.js";

export const ASK_USER_QUESTION = "AskUserQuestion";

/** How long the hook waits for an answer before the CLI times it out, in seconds. */
export const ASK_USER_TIMEOUT_S = 7 * 24 * 60 * 60;

/** The single option an answered question resolves with; the answers ride alongside it. */
export const ANSWER_OPTION = { optionId: "answer", name: "Answer", kind: "allow_once" } as const;

const DISMISSED =
  "The user dismissed these questions without answering. Do not ask them again: " +
  "proceed with your best judgement and say which option you assumed.";

const MALFORMED =
  "AskUserQuestion needs `questions`: 1-4 items, each with `question`, `header` and " +
  "2-4 `options` that have a `label`. Fix the input and call it again.";

/** The questions in an AskUserQuestion input, or undefined if the input is malformed. */
export function parseQuestions(input: unknown): UserQuestion[] | undefined {
  const raw = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: UserQuestion[] = [];
  for (const q of raw) {
    const r = q as Record<string, unknown>;
    if (typeof r?.question !== "string" || !Array.isArray(r.options)) return undefined;
    const options = (r.options as Array<Record<string, unknown>>)
      .filter((o) => typeof o?.label === "string")
      .map((o) => ({
        label: o.label as string,
        ...(typeof o.description === "string" ? { description: o.description } : {}),
        ...(typeof o.preview === "string" ? { preview: o.preview } : {}),
      }));
    if (options.length === 0) return undefined;
    out.push({
      question: r.question,
      header: typeof r.header === "string" ? r.header : "",
      options,
      multiSelect: r.multiSelect === true,
    });
  }
  return out;
}

const deny = (reason: string) => ({
  continue: true,
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/** Ask the user through `ask` and turn the answer into the PreToolUse hook's output. */
export async function askUserHook(args: {
  sessionId: string;
  toolCallId: string;
  toolInput: unknown;
  ask: (req: PermissionRequest) => Promise<PermissionAnswer>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const questions = parseQuestions(args.toolInput);
  if (!questions) return deny(MALFORMED);
  const asked = args.ask({
    sessionId: args.sessionId,
    toolCallId: args.toolCallId,
    title: questions.length === 1 ? questions[0].question : `The agent has ${questions.length} questions`,
    options: [{ ...ANSWER_OPTION }],
    questions,
  });
  // A stopped turn aborts the hook; the bridge settles the pending request itself.
  const aborted = new Promise<PermissionAnswer>((resolve) => {
    if (args.signal?.aborted) resolve({ cancelled: true });
    args.signal?.addEventListener("abort", () => resolve({ cancelled: true }), { once: true });
  });
  const ans = await Promise.race([asked, aborted]);
  if ("cancelled" in ans || !ans.answers || Object.keys(ans.answers).length === 0) return deny(DISMISSED);
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...(args.toolInput as Record<string, unknown>), answers: ans.answers },
    },
  };
}
