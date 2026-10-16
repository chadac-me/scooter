/**
 * ScooterBackend: an AHP backend exposing exactly ONE Scooter conversation to VS Code.
 *
 *  - Root advertises one agent ("scooter") with one model and no protected resources,
 *    so VS Code needs no GitHub/Copilot sign-in.
 *  - The conversation is the session `scooter:/<conversationId>`. Any session VS Code
 *    tries to create is an alias of the same conversation (same history, same live
 *    stream), so a "new chat" in VS Code just continues this conversation.
 *  - The conversation's AG-UI event log (history + live) is mapped to AHP chat actions
 *    and published through the protocol core, whose reducers build the turns.
 *  - Client prompts / cancels go to the router; tool approvals are rejected (they stay
 *    in the Scooter web UI, since anything in the pod could otherwise self-approve).
 */
import type { ListSessionsResult } from "@microsoft/agent-host-protocol";
import type { ProtocolCore } from "./vendor/hydra-ahp/protocol/core.js";
import type { ActionDecision, ActionRequest, Backend, ClientContext } from "./vendor/hydra-ahp/protocol/backend.js";
import { ErrorCodes, RpcError } from "./vendor/hydra-ahp/rpc/peer.js";

export interface ScooterApi {
  /** Stream the conversation's AG-UI events: full replay, then live. Calls onEvent per event; resolves when the stream ends. */
  stream(onEvent: (ev: AguiEvent) => void, signal: AbortSignal): Promise<void>;
  sendMessage(text: string): Promise<void>;
  cancel(): Promise<void>;
}

export type AguiEvent = { type: string; [k: string]: any };

const ROOT = "ahp-root://";
const PROVIDER = "scooter";
const DEFAULT_CHAT_PREFIX = "ahp-chat://default/";
const IDLE = 1;
const chatOf = (session: string) => DEFAULT_CHAT_PREFIX + Buffer.from(session, "utf8").toString("base64url");
const A = (v: Record<string, unknown>) => v as never;

export interface ScooterBackendOptions {
  conversationId: string;
  title?: string;
  workspaceUri?: string; // e.g. vscode-remote or file URI of the workspace folder
  conversationUrl?: string; // link back to the Scooter web UI
  api: ScooterApi;
  log?: (msg: string) => void;
}

export class ScooterBackend implements Backend {
  readonly serverInfo = { name: "scooter-ahp", version: "0.1.0" };
  readonly defaultDirectory: string;
  private core!: ProtocolCore;
  private readonly primary: string;
  /** Every session URI that views this conversation (primary + VS Code-created aliases). */
  private readonly sessions = new Set<string>();
  /** Every chat action ever mapped, so a newly created alias can be brought up to date. */
  private readonly log: Array<Record<string, unknown>> = [];
  private readonly abort = new AbortController();
  private readonly createdAt = new Date().toISOString();

  // Mapping state.
  private openTurn: string | undefined;
  private turnStartMs = 0;
  private turnSeq = 0;
  private userText = new Map<string, string>();
  private toolArgs = new Map<string, { name: string; args: string }>();
  /** Turns VS Code started and sent to the router, by text, awaiting their echo in the log. */
  private pendingClientTurns: Array<{ turnId: string; text: string }> = [];
  /** Turn ids VS Code already started (and the reducer already applied). */
  private clientStarted = new Set<string>();

  constructor(private readonly opts: ScooterBackendOptions) {
    this.primary = `${PROVIDER}:/${opts.conversationId}`;
    this.defaultDirectory = opts.workspaceUri ?? "file:///workspace";
  }

  start(core: ProtocolCore): void {
    this.core = core;
    core.createChannel(ROOT, A({
      agents: [{
        provider: PROVIDER,
        displayName: "Scooter",
        description: "This Scooter conversation",
        models: [{ id: "scooter", provider: PROVIDER, name: "Scooter" }],
        protectedResources: [],
      }],
      activeSessions: 1,
    }));
    this.addSession(this.primary, false);
    void this.pump();
  }

  // ── Sessions ───────────────────────────────────────────────────────────

  private addSession(uri: string, announce: boolean): void {
    const chat = chatOf(uri);
    const now = new Date().toISOString();
    const title = this.opts.title ?? "Scooter conversation";
    this.core.createChannel(chat, A({ resource: chat, title, status: IDLE, modifiedAt: now, turns: [] }));
    this.core.createChannel(uri, A({
      provider: PROVIDER, title, status: IDLE, lifecycle: "ready", activeClients: [],
      chats: [{ resource: chat, title, status: IDLE, modifiedAt: now }], defaultChat: chat,
      workingDirectories: [this.defaultDirectory],
    }));
    this.sessions.add(uri);
    // Bring a new alias up to date with everything mapped so far.
    for (const action of this.log) this.core.publish(chat, A(action));
    if (announce) this.core.notify(ROOT, "root/sessionAdded", { channel: ROOT, summary: this.summary(uri) });
  }

  private summary(uri: string) {
    return A({
      resource: uri, provider: PROVIDER, title: this.opts.title ?? "Scooter conversation",
      status: IDLE, createdAt: this.createdAt, modifiedAt: new Date().toISOString(),
      chats: [{ resource: chatOf(uri), title: this.opts.title ?? "Scooter conversation" }],
      defaultChat: chatOf(uri),
      workingDirectories: [this.defaultDirectory],
      project: { uri: this.defaultDirectory, displayName: "workspace" },
    });
  }

  listSessions() {
    return { items: [...this.sessions].map((s) => this.summary(s)) } as never;
  }

  handleCommand(method: string, params: unknown, _client: ClientContext): unknown {
    const body = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "resolveSessionConfig":
        return { schema: { type: "object", properties: {} }, values: {} };
      case "createSession": {
        // VS Code picks the URI; whatever it is, it becomes a view of THIS conversation.
        const channel = body.channel;
        if (typeof channel !== "string" || !channel.startsWith(`${PROVIDER}:/`)) {
          throw new RpcError(ErrorCodes.InvalidParams, `only ${PROVIDER}: sessions exist here`);
        }
        if (!this.sessions.has(channel)) this.addSession(channel, true);
        return null;
      }
      case "disposeSession": {
        const channel = String(body.channel ?? "");
        if (channel !== this.primary && this.sessions.delete(channel)) {
          this.core.removeChannel(chatOf(channel));
          this.core.removeChannel(channel);
          this.core.notify(ROOT, "root/sessionRemoved", { channel: ROOT, session: channel });
        }
        return null;
      }
      case "fetchTurns":
        return {};
      default:
        throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
  }

  // ── Client → Scooter ───────────────────────────────────────────────────

  async handleAction(req: ActionRequest): Promise<ActionDecision> {
    const a = req.action as unknown as Record<string, any>;
    switch (a.type) {
      case "chat/turnStarted": {
        const text: string = a.message?.text ?? "";
        if (!text.trim()) return { accept: false, reason: "empty message" };
        // Remember it BEFORE sending: the router's echo of this user message can arrive on the
        // event stream before the POST returns, and must not open a second turn.
        const pending = { turnId: a.turnId, text };
        this.pendingClientTurns.push(pending);
        this.clientStarted.add(a.turnId);
        // The client's own action opens the turn on ITS chat; mirror it to the other views now.
        this.beginTurn(a.turnId, a.startedAt, text, "user", req.channel);
        // Accept now so the client's own chat opens the turn immediately; send in the background
        // and fail the turn if the router rejects it.
        this.opts.api.sendMessage(text).catch((e) => {
          this.pendingClientTurns = this.pendingClientTurns.filter((p) => p !== pending);
          if (this.openTurn === a.turnId) this.endTurn("error", `Scooter rejected the message: ${(e as Error).message}`);
        });
        return { accept: true };
      }
      case "chat/turnCancelled":
        await this.opts.api.cancel().catch(() => {});
        if (this.openTurn === a.turnId) {
          this.log.push(a);
          for (const s of this.sessions) if (chatOf(s) !== req.channel) this.core.publish(chatOf(s), A(a));
          this.openTurn = undefined;
        }
        return { accept: true };
      case "chat/toolCallConfirmed":
        return { accept: false, reason: "Approve or deny this in the Scooter web UI." };
      default:
        return { accept: true };
    }
  }

  // ── Scooter → AHP ──────────────────────────────────────────────────────

  private emit(action: Record<string, unknown>, skipChat?: string): void {
    this.log.push(action);
    for (const s of this.sessions) {
      const chat = chatOf(s);
      if (chat !== skipChat) this.core.publish(chat, A(action));
    }
  }

  private beginTurn(turnId: string, startedAt: string | undefined, text: string, kind: "user" | "systemNotification", skipChat?: string): void {
    if (this.openTurn) this.endTurn("complete");
    this.openTurn = turnId;
    this.turnStartMs = Date.now();
    this.emit({ type: "chat/turnStarted", turnId, startedAt: startedAt ?? new Date().toISOString(), message: { text, origin: { kind } } }, skipChat);
  }

  private ensureTurn(): string {
    if (!this.openTurn) this.beginTurn(`scooter-turn-${++this.turnSeq}`, undefined, "", "systemNotification");
    return this.openTurn!;
  }

  private endTurn(how: "complete" | "cancelled" | "error", message?: string): void {
    const turnId = this.openTurn;
    if (!turnId) return;
    const duration = Math.max(0, Date.now() - this.turnStartMs);
    if (how === "complete") this.emit({ type: "chat/turnComplete", turnId, duration });
    else if (how === "cancelled") this.emit({ type: "chat/turnCancelled", turnId, duration });
    else this.emit({ type: "chat/error", turnId, duration, part: { kind: "error", error: { errorType: "run_error", message: message ?? "Run failed" } } });
    this.openTurn = undefined;
  }

  /** Map one AG-UI event from the conversation log. */
  map(ev: AguiEvent): void {
    switch (ev.type) {
      case "TEXT_MESSAGE_START":
        if (ev.role === "user") this.userText.set(ev.messageId, "");
        else this.emit({ type: "chat/responsePart", turnId: this.ensureTurn(), part: { kind: "markdown", id: ev.messageId, content: "" } });
        return;
      case "TEXT_MESSAGE_CONTENT":
        if (this.userText.has(ev.messageId)) this.userText.set(ev.messageId, this.userText.get(ev.messageId)! + ev.delta);
        else this.emit({ type: "chat/delta", turnId: this.ensureTurn(), partId: ev.messageId, content: ev.delta });
        return;
      case "TEXT_MESSAGE_END": {
        const text = this.userText.get(ev.messageId);
        if (text === undefined) return;
        this.userText.delete(ev.messageId);
        const i = this.pendingClientTurns.findIndex((p) => p.text === text);
        if (i >= 0) { this.pendingClientTurns.splice(i, 1); return; } // VS Code already opened this turn
        this.beginTurn(`scooter-${ev.messageId}`, undefined, text, "user");
        return;
      }
      case "SYSTEM_MESSAGE":
        this.beginTurn(`scooter-${ev.messageId}`, undefined, `[${ev.source ?? "system"}] ${ev.text ?? ""}`, "systemNotification");
        return;
      case "REASONING_MESSAGE_START":
        this.emit({ type: "chat/responsePart", turnId: this.ensureTurn(), part: { kind: "reasoning", id: ev.messageId, content: "" } });
        return;
      case "REASONING_MESSAGE_CONTENT":
        this.emit({ type: "chat/reasoning", turnId: this.ensureTurn(), partId: ev.messageId, content: ev.delta });
        return;
      case "TOOL_CALL_START":
        this.toolArgs.set(ev.toolCallId, { name: ev.toolCallName, args: "" });
        this.emit({ type: "chat/toolCallStart", turnId: this.ensureTurn(), toolCallId: ev.toolCallId, toolName: ev.toolCallName, displayName: prettyTool(ev.toolCallName) });
        return;
      case "TOOL_CALL_ARGS": {
        const t = this.toolArgs.get(ev.toolCallId);
        if (t) t.args += ev.delta;
        return;
      }
      case "TOOL_CALL_END": {
        const t = this.toolArgs.get(ev.toolCallId);
        this.emit({ type: "chat/toolCallReady", turnId: this.ensureTurn(), toolCallId: ev.toolCallId, invocationMessage: describeTool(t?.name, t?.args), confirmed: "not-needed" });
        return;
      }
      case "TOOL_CALL_RESULT": {
        const t = this.toolArgs.get(ev.toolCallId);
        this.toolArgs.delete(ev.toolCallId);
        const content = String(ev.content ?? "");
        this.emit({ type: "chat/toolCallComplete", turnId: this.ensureTurn(), toolCallId: ev.toolCallId, result: {
          success: true, pastTenseMessage: `Ran ${prettyTool(t?.name)}`,
          content: [{ type: "text", text: content.length > 4000 ? content.slice(0, 4000) + "\n…(truncated)" : content }],
        } });
        return;
      }
      case "RUN_STARTED":
        this.ensureTurn();
        return;
      case "RUN_FINISHED":
        if (ev.outcome?.type === "interrupt") {
          const link = this.opts.conversationUrl ? ` [Open Scooter](${this.opts.conversationUrl})` : "";
          const id = `approval-${Date.now()}`;
          this.emit({ type: "chat/responsePart", turnId: this.ensureTurn(), part: { kind: "markdown", id, content: `\n\n> ⏸ **Waiting for approval** — answer it in the Scooter web UI.${link}\n` } });
          return; // the run resumes in the same turn once answered
        }
        this.endTurn("complete");
        return;
      case "RUN_ERROR":
        this.ensureTurn();
        this.endTurn("error", ev.message);
        return;
      case "CANCEL_REQUESTED":
        this.endTurn("cancelled");
        return;
      default:
        return; // QUEUE_UPDATED, CONTEXT_USAGE, PERMISSION_RESOLVED, … not surfaced yet
    }
  }

  private async pump(): Promise<void> {
    // The events endpoint replays the full log on every connect; skip what we've mapped.
    let seen = 0;
    while (!this.abort.signal.aborted) {
      let i = 0;
      try {
        await this.opts.api.stream((ev) => { if (i++ >= seen) { seen++; this.map(ev); } }, this.abort.signal);
      } catch (e) {
        this.opts.log?.(`event stream error: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  stop(): void { this.abort.abort(); }
}

function prettyTool(name?: string): string {
  if (!name) return "tool";
  return name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
}

function describeTool(name?: string, args?: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(args || "{}");
    detail = parsed.command ?? parsed.description ?? parsed.path ?? parsed.file_path ?? parsed.query ?? "";
  } catch { /* partial or non-JSON args */ }
  detail = String(detail);
  return detail ? `${prettyTool(name)}: \`${detail.length > 200 ? detail.slice(0, 200) + "…" : detail}\`` : prettyTool(name);
}
