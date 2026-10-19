/**
 * Which CLI built-ins the model may use, and what to say when it may not. Every
 * built-in is explicitly aliased, allowed or denied, and anything not named is denied
 * too, so a tool added by a future CLI release cannot stall a headless turn on a
 * permission prompt. Enforcement is the PreToolUse hook, which runs for every call.
 */

/** Built-ins that run in the sandbox via the aliased MCP tools (see sandboxMcp.ts). */
export const ALIASED_BUILTINS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] as const;

/** Built-ins that are safe as-is, where ToolSearch enumerates the deferred scooter-env tools and Skill invokes a discovered .claude/skills entry. */
export const ALLOWED_BUILTINS = ["TodoWrite", "ToolSearch", "Skill"] as const;

/** The CLI's native subagent built-ins across releases (`Task` was renamed `Agent`); a native subagent runs inside the CLI, so it never becomes a conversation and never appears in the UI. */
export const SUBAGENT_BUILTINS = ["Task", "Agent", "Workflow"] as const;

/** What the model sees when it reaches for a native subagent tool. */
export const SUBAGENT_REDIRECT =
  "Native subagents are not available here. Use the scooter-env `spawn_subagent` tool " +
  "instead (load it with ToolSearch if needed): it runs the subagent in this " +
  "conversation's sandbox and reports back through the UI.";

/** Built-ins that are not supported, with the instruction the model sees so it retries on the right tool. */
export const TOOL_REDIRECTS: Record<string, string> = {
  ...Object.fromEntries(SUBAGENT_BUILTINS.map((t) => [t, SUBAGENT_REDIRECT])),
  SendMessage:
    "SendMessage is not available here. Use the scooter-env `send_to_subagent` tool " +
    "to message a subagent you spawned with `spawn_subagent`.",
  ListAgents: "ListAgents is not available here. Use the scooter-env `list_subagents` tool.",
  AskUserQuestion:
    "There is no interactive question channel here — the user reads this conversation " +
    "asynchronously. State the question and the options in your REPLY, say which option " +
    "you are proceeding with and why, and continue. Do not block waiting for an answer.",
  // Search comes from a search contrib over the broker's MCP server and each provider names its own tool, so the message describes the tool by shape.
  WebSearch:
    "The WebSearch tool is not available here. Use the `*_web_search` tool in your " +
    "tool list instead (e.g. `brave_web_search`) — and if several are listed, pick " +
    "ONE rather than querying every index. If there isn't one, this deployment has no " +
    "search provider configured — say so rather than retrying, and use `web_fetch` " +
    "on a URL you know.",
  WebFetch:
    "The WebFetch tool is not available here. Use the scooter-env `web_fetch` tool " +
    "instead — it fetches through the platform and refuses internal addresses.",
  NotebookEdit:
    "Jupyter notebooks are not supported here. Edit the file directly with the " +
    "sandbox edit tool.",
};

export type ToolDecision =
  | { allow: true }
  | { allow: false; reason: string };

/** Decide whether `toolName` may run, denying unrecognised names; `extraAllowed` carries the dynamically-named MCP tools. */
export function decideTool(toolName: string, extraAllowed: readonly string[] = []): ToolDecision {
  // MCP tools are ours by construction and are gated by the bridge's own permission flow.
  if (toolName.startsWith("mcp__")) return { allow: true };
  if ((ALLOWED_BUILTINS as readonly string[]).includes(toolName)) return { allow: true };
  if (extraAllowed.includes(toolName)) return { allow: true };

  const redirect = TOOL_REDIRECTS[toolName];
  if (redirect) return { allow: false, reason: redirect };

  // An aliased built-in reaching here means the model asked for the local tool rather than the sandbox one.
  if ((ALIASED_BUILTINS as readonly string[]).includes(toolName)) {
    return {
      allow: false,
      reason:
        `${toolName} must run in the sandbox. Use the mcp__sandbox__ tool of the same ` +
        `name — the local built-in would run outside this conversation's workspace.`,
    };
  }

  return {
    allow: false,
    reason:
      `${toolName} is not available in this environment. Do not retry it; use one of ` +
      `the tools you were given instead.`,
  };
}
