/**
 * Conversation is the object the UI talks to instead of passing a raw id around. A
 * conversation exists in the UI before the server creates it on the first send, and only
 * the server may assign its id. `key` is stable for the conversation's whole life and `id`
 * is the server's, undefined until creation; reads answer empty before creation, actions
 * create first, and the id is reachable only through `serverId()`.
 */

import type { AgentHostConfig } from "./client.js";

/** The marker for a conversation the server has not assigned an id yet, a frozen non-string value so `serverId ?? localKey` cannot compile. */
export const AWAITING_ID = Object.freeze({ kind: "awaiting-conversation-id" as const });
export type AwaitingId = typeof AWAITING_ID;

/** A conversation id, or the explicit "not created yet" marker. */
export type MaybeConversationId = string | AwaitingId;

/** Narrow to a usable server id, treating a blank string as no id. */
export function hasId(id: MaybeConversationId): id is string {
  return typeof id === "string" && id.trim() !== "";
}

/** The id if the server actually issued one, else undefined, so a blank id never passes the guards below. */
const serverIssued = (id: string | null | undefined): string | undefined =>
  typeof id === "string" && id.trim() !== "" ? id : undefined;

export interface ConversationSnapshot {
  /** Stable local identity that never changes, including when the server id arrives. */
  key: string;
  /** The server's conversation id, or undefined before it has been created. */
  id?: string;
  /** True once the server has created this conversation. */
  created: boolean;
}

/** Creates the conversation server-side and returns its id, or null on failure. */
export type CreateConversation = () => Promise<string | null>;

/** Called after the server assigns an id, so the store can record it. */
export type OnCreated = (key: string, id: string) => void;

export class Conversation {
  readonly key: string;
  #id: string | undefined;
  /** How this conversation reaches the server. */
  readonly #config: AgentHostConfig;
  readonly #create: CreateConversation;
  readonly #onCreated: OnCreated | undefined;
  /** One in-flight create shared by concurrent callers. */
  #creating: Promise<string | null> | undefined;

  constructor(opts: {
    key: string;
    id?: string;
    config: AgentHostConfig;
    create: CreateConversation;
    onCreated?: OnCreated;
  }) {
    this.key = opts.key;
    this.#id = serverIssued(opts.id);
    this.#config = opts.config;
    this.#create = opts.create;
    this.#onCreated = opts.onCreated;
  }

  /** A conversation the server already knows, whose key is its id. */
  static existing(
    id: string,
    config: AgentHostConfig,
    create: CreateConversation,
    onCreated?: OnCreated,
  ): Conversation {
    return new Conversation({ key: id, id, config, create, onCreated });
  }

  /** A conversation the user has started but not yet sent in, keyed by a local placeholder until `ensureCreated()` runs. */
  static pending(
    key: string,
    config: AgentHostConfig,
    create: CreateConversation,
    onCreated?: OnCreated,
  ): Conversation {
    return new Conversation({ key, config, create, onCreated });
  }

  /** The server's id, or undefined if this conversation does not exist server-side yet. */
  serverId(): string | undefined {
    return this.#id;
  }

  get created(): boolean {
    return this.#id !== undefined;
  }

  /** Whether a create is in flight: the server may be about to issue an id though `serverId()` is still undefined. */
  get creating(): boolean {
    return this.#creating !== undefined;
  }

  snapshot(): ConversationSnapshot {
    return { key: this.key, id: this.#id, created: this.created };
  }

  /** Ensure the conversation exists server-side and return its id (null if creation failed), sharing one create among concurrent callers and never changing `key`. */
  async ensureCreated(): Promise<string | null> {
    if (this.#id !== undefined) return this.#id;
    if (this.#creating) return this.#creating;
    this.#creating = (async () => {
      // A blank id from the minter is a failed create.
      const id = serverIssued(await this.#create());
      if (id) {
        this.#id = id;
        this.#onCreated?.(this.key, id);
      }
      return id ?? null;
    })().finally(() => {
      this.#creating = undefined;
    });
    return this.#creating;
  }

  /** Run `fn` against the server id for an action, creating the conversation first if needed and throwing if creation fails. */
  async withId<T>(fn: (id: string) => Promise<T>): Promise<T> {
    const id = await this.ensureCreated();
    if (!id) throw new Error("could not create the conversation — please retry");
    return fn(id);
  }

  /** The URL that shares this conversation, or undefined before the server has created it. */
  shareUrl(origin: string): string | undefined {
    const id = this.#id;
    return id === undefined ? undefined : `${origin}/?thread=${encodeURIComponent(id)}`;
  }

  /** The agent-host address for a per-conversation path, or undefined before creation. */
  url(path: string): string | undefined {
    const id = this.#id;
    if (id === undefined) return undefined;
    const base = this.#config.baseUrl.replace(/\/$/, "");
    return `${base}/conversations/${encodeURIComponent(id)}${path}`;
  }

  /** The transport config for collaborators that construct their own client; prefer url()/withId(). */
  config(): AgentHostConfig {
    return this.#config;
  }

  /** Run `fn` against the server id for a read only if the conversation exists, else return `fallback` without touching the network. */
  async ifCreated<T>(fn: (id: string) => Promise<T>, fallback: T): Promise<T> {
    const id = this.#id;
    if (id === undefined) return fallback;
    return fn(id);
  }
}
