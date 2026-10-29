/**
 * Match an agent tool call to a provider-flavored visualization.
 *
 * goose surfaces an MCP tool through the ACP stream as "<Server>: <Title-Cased Tool
 * Name>" (e.g. "Scooter-env: Slack Respond"), so the incoming string is normalized
 * to the tool-name identity ("slack_respond") and matched against the known tool
 * names, with the raw registerTool titles accepted as a fallback. Returns null for
 * anything not specialized, and the caller renders the generic ToolFallback. A
 * contrib registers its tools through the runtime manifest (contribManifest.ts), so
 * the provider is an open string rather than an exhaustive union.
 */

import type { ContribToolCard } from "./contribTypes.js";
import { contribToolCards, contribToolTitles } from "./contribManifest.js";

/** A source name ("slack", a contrib's name) or "shell". */
export type ToolKind = string;

export interface ToolCallVisual {
  /** The provider (slack/…) or "shell", which the icon lookup renders as a terminal glyph. */
  provider: ToolKind;
  /** What the agent posted / the command it ran. "" if absent. */
  body: string;
  /** A short human verb for the header, e.g. "replied in Slack" / "ran a command". */
  action: string;
}

/** Keyed by the underlying tool name; the fallback for stacks that serve no manifest
 *  (local dev, the fast e2e stack), consulted after the manifest. */
const BUILTIN_BY_TOOL: Record<string, ContribToolCard> = {
  slack_respond: { provider: "slack", argKey: "text", action: "replied in Slack" },
  slack_react: { provider: "slack", argKey: "emoji", action: "reacted in Slack" },
  github_comment: { provider: "github", argKey: "body", action: "commented on GitHub" },
};

/** The registerTool `title` strings, accepted as a fallback for ACP paths that surface the raw title. */
const BUILTIN_BY_TITLE: Record<string, string> = {
  "respond in the slack thread": "slack_respond",
  "react to the slack message": "slack_react",
  "comment on the github pr/issue": "github_comment",
};

/** Both lookups consult the manifest first and resolve per call, since the manifest is fetched at runtime. */
function cardFor(tool: string): ContribToolCard | undefined {
  return contribToolCards()[tool] ?? BUILTIN_BY_TOOL[tool];
}

function toolForTitle(title: string): string | undefined {
  return contribToolTitles()[title] ?? BUILTIN_BY_TITLE[title];
}

/** Normalize goose's "Scooter-env: Slack Respond" (or a raw tool name) to the tool-name identity "slack_respond". */
export function normalizeToolName(toolName: string): string {
  const afterColon = toolName.includes(":") ? toolName.slice(toolName.lastIndexOf(":") + 1) : toolName;
  return afterColon
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Decide the provider visualization for a tool call (`toolName` is whatever the stream carried), or null to fall back. */
export function matchToolCall(toolName: string, args: unknown): ToolCallVisual | null {
  const norm = normalizeToolName(toolName);
  const tool = cardFor(norm) ? norm : toolForTitle(toolName.trim().toLowerCase());
  const meta = tool ? cardFor(tool) : undefined;
  if (meta) {
    const raw = asRecord(args)[meta.argKey];
    const body = typeof raw === "string" ? raw : "";
    return { provider: meta.provider, body, action: meta.action };
  }
  // Shell tools: show the command on a compact card, since the result is a
  // terminal-handle blob with no stdout.
  const cmd = shellCommand(toolName, norm, args);
  if (cmd !== null) return { provider: "shell", body: cmd, action: "ran a command" };
  return null;
}

/** The command a shell/terminal tool ran, or null if this is not one; the raw name is
 *  checked as well because goose titles its shell tool "run: <cmd>" and normalization
 *  strips everything before the colon. */
function shellCommand(rawName: string, norm: string, args: unknown): string | null {
  const a = asRecord(args);
  const cmd = a.command ?? a.cmd;
  const hasCmdArg = typeof cmd === "string";
  const raw = rawName.trim().toLowerCase();
  const shellish =
    norm === "shell" ||
    norm.startsWith("run_") ||
    norm.startsWith("execute") ||
    raw === "shell" ||
    raw.startsWith("run:") ||
    raw.startsWith("run ");
  if (!shellish && !hasCmdArg) return null;
  return hasCmdArg ? (cmd as string) : "";
}

/**
 * Extract a one-line status from a tool result, unwrapping the plain-string, MCP
 * `{content:[{text}]}`, ACP `[{content:{text}}]` and `{text}` shapes, or "" rather
 * than a JSON dump.
 */
export function resultStatusText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result.trim();

  const pickText = (v: unknown): string => {
    const r = asRecord(v);
    if (typeof r.text === "string") return r.text;
    // { content: "..." } | { content: { text } } | { content: [{ text }] }
    if (r.content !== undefined) {
      if (typeof r.content === "string") return r.content;
      if (Array.isArray(r.content)) return r.content.map(pickText).filter(Boolean).join("\n");
      const c = asRecord(r.content);
      if (typeof c.text === "string") return c.text;
    }
    return "";
  };

  if (Array.isArray(result)) {
    const parts = result.map(pickText).filter(Boolean);
    if (parts.length) return parts.join("\n").trim();
    return "";
  }
  const single = pickText(result);
  return single.trim();
}
