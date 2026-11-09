/**
 * ScooterBackend: an AHP backend exposing this sandbox's Scooter conversation to VS Code,
 * plus one child "session" conversation per extra chat VS Code creates.
 *
 *  - Root advertises one agent ("scooter") with one model and no protected resources,
 *    so VS Code needs no GitHub/Copilot sign-in.
 *  - The primary session `scooter:/<conversationId>` is this conversation.
 *  - `createSession` starts a child session through the router; the URI VS Code picked
 *    maps to it. `disposeSession` suspends the child and hides it from VS Code.
 *  - Each session is a ConversationView with its own event pump and turn mapping.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ConversationView, PROVIDER, type ScooterApi } from "./conversationView.js";
import type { ProtocolCore } from "./vendor/hydra-ahp/protocol/core.js";
import type { ActionDecision, ActionRequest, Backend, ClientContext } from "./vendor/hydra-ahp/protocol/backend.js";
import { ErrorCodes, RpcError } from "./vendor/hydra-ahp/rpc/peer.js";

export type { AguiEvent, ScooterApi } from "./conversationView.js";

const ROOT = "ahp-root://";

export interface ChildSession { id: string; title?: string; status?: string }

/** The router's session routes on the primary conversation, plus per-conversation access. */
export interface SessionsApi {
  create(): Promise<ChildSession>;
  list(): Promise<ChildSession[]>;
  /** Suspends a session; its history stays. */
  end(id: string): Promise<void>;
  /** The self-access API for one conversation (the primary or a session). */
  conversation(id: string): ScooterApi;
}

export interface ScooterBackendOptions {
  conversationId: string;
  title?: string;
  workspaceUri?: string; // e.g. vscode-remote or file URI of the workspace folder
  conversationUrl?: string; // link back to the Scooter web UI
  api: SessionsApi;
  /** Where session URIs and hidden sessions persist across bridge restarts. */
  statePath?: string;
  log?: (msg: string) => void;
}

/** What survives a bridge restart: VS Code's URI per session, and sessions VS Code deleted. */
interface SavedState { uris: Record<string, string>; disposed: string[] }

export class ScooterBackend implements Backend {
  readonly serverInfo = { name: "scooter-ahp", version: "0.2.0" };
  readonly defaultDirectory: string;
  private core!: ProtocolCore;
  /** Every session VS Code can see, by URI. */
  private readonly views = new Map<string, ConversationView>();
  private readonly saved: SavedState;
  private loaded: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ScooterBackendOptions) {
    this.defaultDirectory = opts.workspaceUri ?? "file:///workspace";
    this.saved = load(opts.statePath);
  }

  start(core: ProtocolCore): void {
    this.core = core;
    core.createChannel(ROOT, {
      agents: [{
        provider: PROVIDER,
        displayName: "Scooter",
        description: "This Scooter conversation",
        models: [{ id: "scooter", provider: PROVIDER, name: "Scooter" }],
        protectedResources: [],
      }],
      activeSessions: 1,
    } as never);
    this.addView(`${PROVIDER}:/${this.opts.conversationId}`, this.opts.conversationId, this.opts.title ?? "Scooter conversation");
    this.loaded = this.refresh();
  }

  stop(): void {
    for (const v of this.views.values()) v.stop();
  }

  // ── Sessions ───────────────────────────────────────────────────────────

  private addView(uri: string, conversationId: string, title: string): ConversationView {
    const view = new ConversationView(this.core, {
      uri, conversationId, title,
      directory: this.defaultDirectory,
      conversationUrl: urlFor(this.opts.conversationUrl, conversationId),
      api: this.opts.api.conversation(conversationId),
      log: this.opts.log,
    });
    this.views.set(uri, view);
    view.start();
    return view;
  }

  /** Adds a view for each live session the router knows and VS Code didn't delete. */
  private async refresh(): Promise<void> {
    let children: ChildSession[];
    try {
      children = await this.opts.api.list();
    } catch (e) {
      this.opts.log?.(`listing sessions failed: ${(e as Error).message}`);
      return;
    }
    const known = new Set([...this.views.values()].map((v) => v.conversationId));
    for (const c of children) {
      if (known.has(c.id) || c.status === "ended" || this.saved.disposed.includes(c.id)) continue;
      const uri = Object.keys(this.saved.uris).find((u) => this.saved.uris[u] === c.id) ?? `${PROVIDER}:/${c.id}`;
      if (this.views.has(uri)) continue;
      this.addView(uri, c.id, c.title || "VS Code session");
    }
  }

  async listSessions() {
    await this.loaded;
    this.loaded = this.refresh();
    await this.loaded;
    return { items: [...this.views.values()].map((v) => v.summary()) } as never;
  }

  async handleCommand(method: string, params: unknown, _client: ClientContext): Promise<unknown> {
    const body = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "resolveSessionConfig":
        return { schema: { type: "object", properties: {} }, values: {} };
      case "createSession": {
        // VS Code picks the URI; it becomes a new child session conversation.
        const channel = body.channel;
        if (typeof channel !== "string" || !channel.startsWith(`${PROVIDER}:/`)) {
          throw new RpcError(ErrorCodes.InvalidParams, `only ${PROVIDER}: sessions exist here`);
        }
        await this.loaded;
        if (this.views.has(channel)) return null;
        let child: ChildSession;
        try {
          child = await this.opts.api.create();
        } catch (e) {
          throw new RpcError(ErrorCodes.InternalError, `Scooter could not start a session: ${(e as Error).message}`);
        }
        this.saved.uris[channel] = child.id;
        this.save();
        const view = this.addView(channel, child.id, child.title || "VS Code session");
        this.core.notify(ROOT, "root/sessionAdded", { channel: ROOT, summary: view.summary() });
        return null;
      }
      case "disposeSession": {
        const channel = String(body.channel ?? "");
        const view = this.views.get(channel);
        if (!view || view.conversationId === this.opts.conversationId) return null;
        this.views.delete(channel);
        view.remove();
        delete this.saved.uris[channel];
        this.saved.disposed.push(view.conversationId);
        this.save();
        this.core.notify(ROOT, "root/sessionRemoved", { channel: ROOT, session: channel });
        await this.opts.api.end(view.conversationId).catch((e) => this.opts.log?.(`ending session ${view.conversationId} failed: ${(e as Error).message}`));
        return null;
      }
      case "fetchTurns":
        return {};
      default:
        throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
  }

  async handleAction(req: ActionRequest): Promise<ActionDecision> {
    const view = [...this.views.values()].find((v) => v.chat === req.channel || v.uri === req.channel);
    if (!view) return { accept: false, reason: "unknown session" };
    return view.handleAction(req);
  }

  private save(): void {
    if (!this.opts.statePath) return;
    try {
      writeFileSync(this.opts.statePath, JSON.stringify(this.saved), { mode: 0o600 });
    } catch (e) {
      this.opts.log?.(`saving sessions failed: ${(e as Error).message}`);
    }
  }
}

function load(path?: string): SavedState {
  try {
    const raw = JSON.parse(readFileSync(path!, "utf8")) as Partial<SavedState>;
    return { uris: raw.uris ?? {}, disposed: raw.disposed ?? [] };
  } catch {
    return { uris: {}, disposed: [] };
  }
}

/** The web UI link for a conversation, from the primary's `…/?thread=<id>`. */
function urlFor(primaryUrl: string | undefined, conversationId: string): string | undefined {
  if (!primaryUrl) return undefined;
  try {
    const u = new URL(primaryUrl);
    u.searchParams.set("thread", conversationId);
    return u.toString();
  } catch {
    return primaryUrl;
  }
}
