/**
 * Blocking tools over the bridge's permission flow. A tool a contrib declares in
 * `agent.blockingTools` (Claude's AskUserQuestion, for ask-user) is sent to the user as a
 * request of its `kind`, and the PreToolUse hook waits for the answer, then merges the
 * result object into `updatedInput`, which the CLI accepts as the tool's user interaction
 * (dontAsk mode would deny the tool before canUseTool ever ran).
 */

import type { BlockingTool, PermissionAnswer, PermissionRequest } from "./types.js";

/** How long the hook waits for an answer before the CLI times it out, in seconds. */
export const BLOCKING_TOOL_TIMEOUT_S = 7 * 24 * 60 * 60;

/** The single option a blocking request resolves with; the result rides alongside it. */
export const ANSWER_OPTION = { optionId: "answer", name: "Answer", kind: "allow_once" } as const;

const deny = (reason: string) => ({
  continue: true,
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/** Send the tool's input to the user as a `tool.kind` request and turn the answer into the PreToolUse hook's output. */
export async function blockingToolHook(args: {
  tool: BlockingTool;
  sessionId: string;
  toolCallId: string;
  toolInput: unknown;
  ask: (req: PermissionRequest) => Promise<PermissionAnswer>;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const input =
    args.toolInput && typeof args.toolInput === "object" && !Array.isArray(args.toolInput)
      ? (args.toolInput as Record<string, unknown>)
      : {};
  const asked = args.ask({
    sessionId: args.sessionId,
    toolCallId: args.toolCallId,
    title: args.tool.title,
    options: [{ ...ANSWER_OPTION }],
    request: { kind: args.tool.kind, data: input },
  });
  // A stopped turn aborts the hook; the bridge settles the pending request itself.
  const aborted = new Promise<PermissionAnswer>((resolve) => {
    if (args.signal?.aborted) resolve({ cancelled: true });
    args.signal?.addEventListener("abort", () => resolve({ cancelled: true }), { once: true });
  });
  const ans = await Promise.race([asked, aborted]);
  if ("cancelled" in ans || !ans.result) return deny(args.tool.dismissed);
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input, ...ans.result },
    },
  };
}
