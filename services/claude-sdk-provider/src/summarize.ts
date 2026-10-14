/**
 * One-off conversation summarizer for manual compaction. It runs a single tool-less
 * Claude Agent SDK query() in a fresh session to condense the older part of a
 * conversation into recap text, using the conversation's own auth and model. It is a
 * stateless completion, not part of the AcpClient surface.
 */

/** A user/assistant turn to summarize, matching the agent-host TranscriptTurn shape. */
export interface SummaryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface SummarizeDeps {
  /** Subscription OAuth token (CLAUDE_CODE_OAUTH_TOKEN). */
  oauthToken: string;
  /** Model to summarize with (the conversation's model). */
  model: string;
  /** Absolute path to the glibc `claude` CLI; defaults to CLAUDE_CODE_COMMAND, else "claude". */
  claudeCodePath?: string;
  /** Injectable query() for tests; defaults to the real SDK. */
  queryImpl?: (params: { prompt: string; options: Record<string, unknown> }) =>
    AsyncIterable<{ type?: string; message?: { content?: Array<{ type?: string; text?: string }> }; [k: string]: unknown }>;
}

const SYSTEM =
  "You are compacting a long assistant conversation to recover context window. " +
  "Write a CONCISE recap of the conversation so far that a fresh assistant can use to " +
  "continue seamlessly: the user's goals, key decisions, what's been done, current " +
  "state, and any open threads / next steps. Preserve concrete facts (names, paths, " +
  "ids, values). Omit chit-chat. Output ONLY the recap prose — no preamble, no bullets " +
  "about being an AI.";

function turnsToPrompt(turns: SummaryTurn[]): string {
  const body = turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n");
  return `Summarize the earlier part of this conversation into a recap:\n\n${body}`;
}

/** Summarize the given turns into recap text, throwing on any failure. */
export async function summarizeConversation(turns: SummaryTurn[], deps: SummarizeDeps): Promise<string> {
  if (turns.length === 0) return "";
  const query =
    deps.queryImpl ??
    ((await import("@anthropic-ai/claude-agent-sdk")) as { query: SummarizeDeps["queryImpl"] }).query!;

  const q = query({
    prompt: turnsToPrompt(turns),
    options: {
      model: deps.model,
      systemPrompt: SYSTEM,
      pathToClaudeCodeExecutable: deps.claudeCodePath ?? process.env.CLAUDE_CODE_COMMAND ?? "claude",
      // A pure completion: no tools, no MCP servers, no resume.
      allowedTools: [],
      disallowedTools: ["Bash", "Read", "Edit", "Write"],
      maxTurns: 1,
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: deps.oauthToken },
    },
  });

  let out = "";
  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message?.content ?? []) {
        if (block.type === "text" && block.text) out += block.text;
      }
    }
  }
  const recap = out.trim();
  if (!recap) throw new Error("summarizer returned no text");
  return recap;
}
