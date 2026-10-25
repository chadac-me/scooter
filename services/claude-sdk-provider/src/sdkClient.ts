/**
 * AcpClient backed by the Claude Agent SDK, for the `claude-code` provider. It
 * satisfies the same AcpClient interface as the goose-backed client, so the bridge,
 * SessionManager, AG-UI mapping and permission flow are shared. Claude's built-in
 * Bash/Read/Edit/Write are disabled and aliased to an in-process MCP server whose
 * tools exec via ExecBackend into the sandbox pod, while the SDK spawns the `claude`
 * CLI authenticated with CLAUDE_CODE_OAUTH_TOKEN.
 */

import { randomUUID } from "node:crypto";

import type {
  AcpClient,
  InitializeParams,
  NewSessionParams,
  PromptParams,
  PermissionRequest,
  PermissionAnswer,
  SessionUpdate,
  ContentBlock,
} from "./types.js";
import type { BlockingTool, ExecBackend } from "./types.js";
import { sdkMessageToUpdates, type SdkMessage } from "./sdkAdapter.js";
import { createSandboxMcpServer } from "./sandboxMcp.js";
import { decideTool } from "./toolPolicy.js";
import { BLOCKING_TOOL_TIMEOUT_S, blockingToolHook } from "./blockingToolHook.js";
import { debug, debugError } from "./debug.js";

// Stream text/thinking as deltas, threaded into sdkMessageToUpdates so the final assistant message does not re-emit the text.
const INCLUDE_PARTIALS = true;

export interface SdkAcpClientDeps {
  /** Subscription OAuth token, passed to the SDK as env.CLAUDE_CODE_OAUTH_TOKEN. */
  oauthToken: string;
  /** Model for query(). */
  model: string;
  /** The ExecBackend the sandbox-routed MCP tools run through. */
  exec: ExecBackend;
  /** The scooter-env HTTP MCP endpoint URL for this conversation; omit to run with only the sandbox tools. */
  mcpEndpointUrl?: string;
  /** Headers for `mcpEndpointUrl`, carrying the conversation token the endpoint resolves its conversation from. */
  mcpEndpointHeaders?: Record<string, string>;
  /** Additional named MCP servers, each reachable at its own URL, as a BYO container passes one local tunnelled proxy per server. */
  mcpServers?: Array<{ name: string; url: string; headers?: Record<string, string> }>;
  /** Agent identity as the SDK systemPrompt, carrying no skill bodies since the SDK discovers those from `<cwd>/.claude/skills`. */
  systemPrompt: string;
  /** Working dir the SDK scans for `.claude/skills` (and CLAUDE.md). */
  cwd?: string;
  /** Filesystem settings the SDK may load, which must include "project" for skills to be discovered. */
  settingSources?: Array<"user" | "project" | "local">;
  /** Called once with the SDK's init report so the caller can log the discovered skills and command count. */
  onInit?: (info: { skills: unknown[]; commands: number }) => void;
  /** Which discovered skills Claude may invoke ("all" or an exact-name list), which also puts the Skill tool in allowedTools. */
  skills?: "all" | string[];
  /** Extra env for the claude subprocess (e.g. IS_SANDBOX if ever needed). */
  extraEnv?: Record<string, string>;
  /** Absolute path to a glibc `claude` CLI; defaults to CLAUDE_CODE_COMMAND, else "claude" on PATH. */
  claudeCodePath?: string;
  /** Override the SDK's query() for tests; defaults to the real SDK query, imported lazily. */
  queryImpl?: SdkQueryFn;
  /** Back-pressure probe: when it returns true a higher-priority item is waiting, and the next tool-call boundary ends the turn so it can inject. */
  shouldYield?: () => boolean;
  /** Transcript recorder, called with each raw SDK query() message before normalization. */
  recordRaw?: (msg: unknown) => void;
}

/** The minimal shape of the SDK's query() this module depends on, declared locally so it type-checks without the SDK installed. */
interface SdkQuery extends AsyncIterable<SdkMessage> {
  /** Interrupt the running turn. */
  interrupt?(): Promise<void>;
}
/** A minimal mirror of the SDK's `SDKUserMessage`, the streaming-input form that carries a multimodal prompt. */
type SdkUserMessage = {
  type: "user";
  message: { role: "user"; content: SdkContentParam[] };
  parent_tool_use_id: string | null;
};
/** Content-block params emitted into a streaming-input user message. */
type SdkContentParam =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
type SdkQueryFn = (params: { prompt: string | AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => SdkQuery;

/** Flatten a text-only ContentBlock[] prompt to the string query() takes. */
function promptToText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "resource_link" ? b.uri : ""))
    .filter(Boolean)
    .join("\n");
}

/** Map ACP prompt blocks to content-block params for the SDK's streaming-input form, dropping empty text blocks. */
function promptToSdkContent(blocks: ContentBlock[]): SdkContentParam[] {
  const out: SdkContentParam[] = [];
  for (const b of blocks) {
    if (b.type === "image") out.push({ type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } });
    else if (b.type === "resource_link") out.push({ type: "text", text: b.uri });
    else if (b.type === "text" && b.text) out.push({ type: "text", text: b.text });
  }
  return out;
}

/** Map an SDK result message's terminal reason to the bridge's stopReason string. */
function resultStopReason(msg: { subtype?: string; is_error?: boolean }): string {
  if (msg.subtype === "success") return "end_turn";
  return msg.subtype ?? (msg.is_error ? "error" : "end_turn");
}

/** Build a `context_usage` update from the SDK result's modelUsage, or null if it carries no usable usage. */
function emitContextUsage(msg: unknown): SessionUpdate | null {
  const mu = (msg as { modelUsage?: Record<string, {
    inputTokens?: number; outputTokens?: number;
    cacheReadInputTokens?: number; cacheCreationInputTokens?: number; contextWindow?: number;
  }> }).modelUsage;
  if (!mu) return null;
  let used = 0;
  let contextWindow = 0;
  for (const u of Object.values(mu)) {
    // Context usage is the prompt going into the next turn: input plus both cache tiers, with output included as a safe over-estimate.
    used += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (u.outputTokens ?? 0);
    if ((u.contextWindow ?? 0) > contextWindow) contextWindow = u.contextWindow ?? 0;
  }
  if (contextWindow <= 0) return null;
  return { sessionUpdate: "context_usage", usedTokens: used, contextWindow };
}

/** Spawn an SDK-backed AcpClient. */
export async function createSdkAcpClient(deps: SdkAcpClientDeps): Promise<AcpClient> {
  const { server, toolAliases, disallowedTools } = await createSandboxMcpServer(deps.exec);

  // Lazy import so the module graph (and unit tests) load without the SDK.
  const query =
    deps.queryImpl ??
    ((await import("@anthropic-ai/claude-agent-sdk")) as { query: SdkQueryFn }).query;

  const updateCbs = new Set<(sessionId: string, u: SessionUpdate) => void>();
  const terminalCreatedCbs = new Set<(id: string, command: string, args: string[]) => void>();
  let permissionHandler: ((req: PermissionRequest) => Promise<PermissionAnswer>) | undefined;
  /** Suffix so each permission request gets its own id, across client instances too. */
  const permissionNonce = randomUUID().slice(0, 8);
  let permissionSeq = 0;

  let sessionId = "";
  /** Tools that wait on the user, set by newSession (contribs' `agent.blockingTools`). */
  let blockingTools: Record<string, BlockingTool> = {};
  let active: SdkQuery | undefined; // the in-flight query() for cancel()
  let closed = false; // the SDK runs in-process, so alive means not closed

  // The SDK runs in-process, so its failures never reach a stderr the agent-host can tail; keep the last few lines for the dead-on-arrival watchdog to quote.
  const diagnostics: string[] = [];
  const DIAGNOSTICS_MAX = 20;
  const noteDiagnostic = (line: string): void => {
    diagnostics.push(line);
    if (diagnostics.length > DIAGNOSTICS_MAX) diagnostics.shift();
  };
  // The SDK's own session UUID, captured each turn and passed as `resume` on the next prompt so the conversation continues with full history.
  let sdkSessionId: string | undefined;
  /** Init is logged once per client, not once per turn. */
  let loggedInit = false;

  const baseOptions: Record<string, unknown> = {
    model: deps.model,
    systemPrompt: deps.systemPrompt,
    ...(deps.cwd ? { cwd: deps.cwd } : {}),
    ...(deps.settingSources ? { settingSources: deps.settingSources } : {}),
    ...(deps.skills ? { skills: deps.skills } : {}),
    // The SDK's bundled musl `claude` cannot launch on the glibc image, so point it at the glibc CLI on PATH, overridable via CLAUDE_CODE_COMMAND.
    pathToClaudeCodeExecutable: deps.claudeCodePath ?? process.env.CLAUDE_CODE_COMMAND ?? "claude",
    // `sandbox` routes Bash/Read/Edit/Write into the pod; `scooter-env` is the platform HTTP MCP server carrying the scheduler, chat, background-job, model-switch and resize tools.
    mcpServers: {
      sandbox: server,
      ...(deps.mcpEndpointUrl
        ? {
            "scooter-env": {
              type: "http",
              url: deps.mcpEndpointUrl,
              ...(deps.mcpEndpointHeaders ? { headers: deps.mcpEndpointHeaders } : {}),
            },
          }
        : {}),
      // Named servers (the BYOC tunnel supplies these; N per conversation).
      ...Object.fromEntries(
        (deps.mcpServers ?? []).map((m) => [
          m.name,
          { type: "http", url: m.url, ...(m.headers ? { headers: m.headers } : {}) },
        ]),
      ),
    },
    toolAliases,
    disallowedTools,
    // Deny by default: "dontAsk" refuses anything not pre-approved instead of prompting, which the headless CLI could never answer.
    permissionMode: "dontAsk",
    // Suppresses the permission prompt for the tools we own; their real gate is the PreToolUse hook and the bridge's permission flow.
    allowedTools: [
      ...Object.values(toolAliases),
      ...(deps.mcpEndpointUrl ? ["mcp__scooter-env"] : []),
      ...(deps.mcpServers ?? []).map((m) => `mcp__${m.name}`),
      ...(deps.mcpServers ?? []).map((m) => `mcp__${m.name}`),
    ],
    // The enforcement point: PreToolUse runs for every call, and a denial is seen by the model, which redirects onto the scooter-env equivalent (see toolPolicy.ts).
    hooks: {
      PreToolUse: [
        {
          // A blocking tool waits here until the user answers; the other tools return at once.
          timeout: BLOCKING_TOOL_TIMEOUT_S,
          hooks: [
            async (input: unknown, toolUseId?: string, opts?: { signal?: AbortSignal }) => {
              const name = (input as { tool_name?: string })?.tool_name ?? "";
              const blocking = Object.hasOwn(blockingTools, name) ? blockingTools[name] : undefined;
              if (blocking && permissionHandler) {
                return blockingToolHook({
                  tool: blocking,
                  sessionId,
                  toolCallId: toolUseId ?? `block-${permissionNonce}-${++permissionSeq}`,
                  toolInput: (input as { tool_input?: unknown }).tool_input,
                  ask: permissionHandler,
                  signal: opts?.signal,
                });
              }
              const decision = decideTool(name, Object.values(toolAliases));
              if (decision.allow) return { continue: true };
              debugError("[sdk:tool-denied]", `${name}: ${decision.reason}`);
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: decision.reason,
                },
              };
            },
          ],
        },
      ],
    },
    includePartialMessages: INCLUDE_PARTIALS, // stream text deltas
    // Surface the spawned claude CLI's stderr so a CLI failure is not an opaque exit 1.
    stderr: (data: string) => debugError("[sdk:claude-stderr]", data),
    // The SDK replaces the subprocess env with this object rather than merging, so process.env must be spread in.
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: deps.oauthToken, ...(deps.extraEnv ?? {}) },
    // canUseTool is the user-input callback and does not fire for pre-approved tools, so the real yield gate is the tool-call-boundary check in prompt() and this is defence in depth.
    canUseTool: async (toolName: string, input: unknown) => {
      // Back-pressure: if a higher-priority item is waiting, deny with interrupt:true so the turn ends.
      if (deps.shouldYield?.()) {
        return {
          behavior: "deny",
          interrupt: true,
          message:
            "Pausing here: higher-priority work is now waiting for you (a subagent " +
            "finished, or a new message arrived). Finish your turn — do NOT start " +
            "another tool call; you'll receive the pending item on your next turn.",
        };
      }
      if (!permissionHandler) return { behavior: "allow", updatedInput: input };
      // The bridge keys pendingPermissions by toolCallId, so each request needs a unique id; the SDK does not hand us its tool_use id here.
      const permissionId = `perm-${toolName}-${permissionNonce}-${++permissionSeq}`;
      const ans = await permissionHandler({
        sessionId,
        toolCallId: permissionId,
        title: toolName,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      if ("cancelled" in ans || ans.optionId === "deny") return { behavior: "deny", message: "denied by user" };
      return { behavior: "allow", updatedInput: input };
    },
  };

  return {
    async initialize(_p: InitializeParams) {
      return { protocolVersion: 1 };
    },

    async newSession(p: NewSessionParams) {
      blockingTools = p?.blockingTools ?? {};
      // The SDK mints its own session id on first query; this is a stable handle.
      sessionId = `sdk_${Date.now()}`;
      // Clear any resume id so the first prompt starts a fresh SDK session.
      sdkSessionId = undefined;
      return { sessionId };
    },

    async prompt(params: PromptParams): Promise<{ stopReason: string }> {
      // Resume the SDK session so the turn continues the conversation; undefined on the first turn.
      const options = sdkSessionId ? { ...baseOptions, resume: sdkSessionId } : baseOptions;
      // A prompt with an image rides the SDK streaming-input form so the base64 image reaches the model.
      const hasImage = params.prompt.some((b) => b.type === "image");
      const promptArg: string | AsyncIterable<SdkUserMessage> = hasImage
        ? (async function* () {
            yield {
              type: "user",
              message: { role: "user", content: promptToSdkContent(params.prompt) },
              parent_tool_use_id: null,
            } as SdkUserMessage;
          })()
        : promptToText(params.prompt);
      debug("[sdk] prompt: query start, model=%s, resume=%s, multimodal=%s", deps.model, sdkSessionId ?? "(new)", hasImage);
      const q = query({ prompt: promptArg, options });
      active = q;
      let stopReason = "end_turn";
      try {
        for await (const msg of q) {
          // Surface the SDK's init message (the skills it discovered) via onInit so the host can log it.
          const m = msg as { type?: string; subtype?: string; skills?: unknown; slash_commands?: unknown };
          if (m.type === "system" && m.subtype === "init" && !loggedInit) {
            loggedInit = true;
            deps.onInit?.({
              skills: Array.isArray(m.skills) ? (m.skills as unknown[]) : [],
              commands: Array.isArray(m.slash_commands) ? (m.slash_commands as unknown[]).length : 0,
            });
          }
          deps.recordRaw?.(msg);
          // Capture the SDK's session id so the next prompt resumes this same session.
          const sid = (msg as { session_id?: string }).session_id;
          if (sid) sdkSessionId = sid;
          if (msg.type === "result") {
            stopReason = resultStopReason(msg as { subtype?: string; is_error?: boolean });
            // The result carries per-model usage including the context window; emit it for the UI's fill bar.
            const usage = emitContextUsage(msg);
            if (usage) for (const cb of updateCbs) cb(sessionId, usage);
            continue;
          }
          const updates = sdkMessageToUpdates(msg as SdkMessage, INCLUDE_PARTIALS);
          for (const u of updates) {
            for (const cb of updateCbs) cb(sessionId, u);
          }
          // Back-pressure gate: when the agent issues a tool call while a higher-priority item is waiting, stop consuming the stream without interrupting, so the agent goes idle and the resumed session re-issues the call on the next turn.
          if (deps.shouldYield?.() && updates.some((u) => u.sessionUpdate === "tool_call")) {
            debug("[sdk] back-pressure: yielding turn (priority item waiting) — ending stream");
            stopReason = "end_turn";
            break;
          }
        }
      } catch (e) {
        const line = `[sdk] prompt: query stream error: ${e instanceof Error ? e.message : String(e)}`;
        noteDiagnostic(line);
        debugError("[sdk] prompt: query stream error:", e);
        throw e;
      } finally {
        active = undefined;
      }
      debug("[sdk] prompt: stopReason=%s, session=%s", stopReason, sdkSessionId ?? "?");
      return { stopReason };
    },

    async cancel(_sessionId: string) {
      await active?.interrupt?.().catch(() => {});
    },

    async killActiveTerminals() {
      // Interrupting the query stops the running tool; sandbox terminals are ExecBackend handles released per call.
      await active?.interrupt?.().catch(() => {});
    },

    isAlive() {
      // The in-process SDK has no subprocess to crash, so it is alive until close().
      return !closed;
    },

    recentDiagnostics() {
      return [...diagnostics];
    },

    onSessionUpdate(cb) {
      updateCbs.add(cb);
      return () => updateCbs.delete(cb);
    },

    onTerminalCreated(cb) {
      terminalCreatedCbs.add(cb);
      return () => terminalCreatedCbs.delete(cb);
    },

    onPermissionRequest(handler) {
      permissionHandler = handler;
    },

    async close() {
      await active?.interrupt?.().catch(() => {});
    },
  };
}
