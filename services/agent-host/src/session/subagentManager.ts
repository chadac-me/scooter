/** The SubagentManager implementation: spawn/list/check/cancel/send/monitor/search over injectable sessions and store. */

import { randomUUID } from "node:crypto";

import type { SessionId } from "../types.js";
import type { AguiEvent } from "../bridge.js";
import type { SubagentManager, SubagentStatus } from "../agent/subagentTools.js";
import { foldTurnsWithTools } from "../agent/subagentTranscript.js";
import { PRIORITY_INTERRUPT } from "../bridge.js";
import type { SubagentCreator } from "./routerSubagents.js";

/** The minimal child conversation shape the manager reasons about, a subset of SessionManager's
 *  Conversation. */
export interface SubagentConversation {
  id: string;
  title?: string;
  parentId?: string;
  status?: string;
  bridge?: {
    queueState(): { running: boolean };
    cancel(): void;
  };
}

/** The bits of SessionManager the subagent manager drives (narrowed for testing). */
export interface SubagentSessions {
  get(id: SessionId): SubagentConversation | undefined;
  list(): SubagentConversation[];
  spawnChild(parentId: SessionId, childThreadId: string, args: { prompt: string; title?: string; model?: string }): Promise<{ id: string; title?: string }>;
  prompt(id: SessionId, text: string, model?: string, priority?: number, interrupt?: unknown, images?: unknown, files?: unknown, source?: string): Promise<void>;
}

/** The bits of the ConversationStore the manager reads (narrowed for testing). */
export interface SubagentStore {
  readEvents(id: SessionId): AsyncIterable<AguiEvent>;
  readEventsTail?(id: SessionId, runs: number): Promise<AguiEvent[]>;
}

/** A subagent's status as its parent sees it: ended, running (its bridge has a live run), or idle. */
export function subagentStatusOf(c: SubagentConversation): SubagentStatus["status"] {
  if (c.status === "ended") return "ended";
  return c.bridge?.queueState().running ? "running" : "idle";
}

async function collect(it: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  try {
    for await (const e of it) out.push(e);
  } catch {
    /* a read failure yields what we have */
  }
  return out;
}

export function createSubagentManager(
  sessions: SubagentSessions,
  store: SubagentStore,
  createChild?: SubagentCreator,
): SubagentManager {
  /** Resolve a child that belongs to `parentId` (scoping), else undefined. */
  const ownChild = (parentId: string, subagentId: string): SubagentConversation | undefined => {
    const c = sessions.get(subagentId as SessionId);
    return c && c.parentId === parentId ? c : undefined;
  };

  return {
    async spawn(parentId, args) {
      // The router mints the id, before any event.
      const childThreadId = createChild
        ? (await createChild(parentId, { title: args.title, model: args.model })).id
        : randomUUID();
      const child = await sessions.spawnChild(parentId as SessionId, childThreadId, args);
      return { id: child.id, title: child.title };
    },
    async list(parentId) {
      return sessions
        .list()
        .filter((c) => c.parentId === parentId)
        .map((c) => ({ id: c.id, title: c.title, status: subagentStatusOf(c) }));
    },
    async check(parentId, subagentId) {
      const c = ownChild(parentId, subagentId);
      if (!c) return undefined;
      return { id: c.id, title: c.title, status: subagentStatusOf(c) };
    },
    async cancel(parentId, subagentId) {
      const c = ownChild(parentId, subagentId);
      if (!c) return { outcome: "unknown" };
      if (!c.bridge) return { outcome: "already-idle" };
      c.bridge.cancel();
      return { outcome: "cancelled" };
    },
    async send(parentId, subagentId, message) {
      const c = ownChild(parentId, subagentId);
      if (!c) return { outcome: "unknown" };
      // Only a running child has a turn for a course correction to land on.
      if (subagentStatusOf(c) !== "running") return { outcome: "not-running" };
      // Preempt the child's current turn with the clarification, sourced as a system message from
      // the parent.
      await sessions.prompt(
        subagentId as SessionId,
        `[Clarification from your parent agent — factor this into your current work]\n\n${message}`,
        undefined,
        PRIORITY_INTERRUPT,
        "thinking",
        undefined,
        undefined,
        "parent-clarification",
      );
      return { outcome: "sent" };
    },
    async recentTurns(parentId, subagentId, n) {
      const c = ownChild(parentId, subagentId);
      if (!c) return undefined;
      const events = store.readEventsTail
        ? await store.readEventsTail(subagentId as SessionId, Math.max(2, Math.ceil(n / 2)))
        : await collect(store.readEvents(subagentId as SessionId));
      return foldTurnsWithTools(events).slice(-n);
    },
    async searchHistory(parentId, subagentId, query) {
      const c = ownChild(parentId, subagentId);
      if (!c) return undefined;
      const events = await collect(store.readEvents(subagentId as SessionId));
      const q = query.toLowerCase();
      return foldTurnsWithTools(events).filter((t) => t.text.toLowerCase().includes(q));
    },
  };
}
