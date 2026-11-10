/**
 * Hook runs the owner starts from the UI, outside an agent turn (hooks marked
 * `userCanRun`): e.g. kanban's stage gates, run before the user moves a card.
 *
 * A run can take as long as its hook's timeout (tests may take minutes), longer than an
 * HTTP request may stay open behind an ingress, so a run is started and then polled.
 * Runs live in this replica's memory, which is enough: the router sends a conversation's
 * requests to the one agent-host that holds it, and a run lost to a restart reads as
 * unknown, which the UI shows as "try again".
 */

import { randomUUID } from "node:crypto";

import type { HookOutcome } from "./types.js";

export type UserHookRunState =
  | { state: "running"; hook: string; startedAt: number }
  | { state: "done"; hook: string; startedAt: number; endedAt: number; outcome: UserHookOutcome }
  | { state: "error"; hook: string; startedAt: number; endedAt: number; error: string };

/** What the UI is told of a finished run: the hook's verdict, not the agent's view of it. */
export interface UserHookOutcome {
  /** False when the hook didn't run: turned off, its precondition didn't hold, or no match. */
  ran: boolean;
  /** Why the hook refused (exit 2's stderr): for a gate, what failed. */
  block?: string;
  /** Messages the hook addressed to the user. */
  systemMessages: string[];
  /** A crash or timeout the hook didn't treat as a refusal. */
  error?: string;
}

export interface UserHookRunsDeps {
  /** Runs one hook for one conversation, as the agent-host would within a turn. */
  run: (conversationId: string, hookId: string, input: Record<string, unknown>, target?: string) => Promise<HookOutcome>;
  /** How long a finished run stays readable. */
  keepMs?: number;
  now?: () => number;
}

export interface UserHookRuns {
  /** Start `hookId`; returns the run's id at once. */
  start(conversationId: string, hookId: string, input: Record<string, unknown>, target?: string): string;
  /** The run's state, or undefined once forgotten (or on another replica). */
  get(conversationId: string, runId: string): UserHookRunState | undefined;
}

/** A hook's merged outcome, as the UI reads it. */
export function toUserOutcome(out: HookOutcome): UserHookOutcome {
  const ran = out.runs.some((r) => r.decision !== "skipped");
  const failed = out.runs.find((r) => r.decision === "error");
  return {
    ran,
    ...(out.block ? { block: out.block } : out.stop ? { block: out.stop } : {}),
    systemMessages: out.systemMessages,
    ...(failed?.error ? { error: failed.error } : {}),
  };
}

export function createUserHookRuns(deps: UserHookRunsDeps): UserHookRuns {
  const keepMs = deps.keepMs ?? 15 * 60_000;
  const now = deps.now ?? Date.now;
  const runs = new Map<string, UserHookRunState>();
  const key = (conversationId: string, runId: string) => `${conversationId}\u0000${runId}`;

  const sweep = () => {
    const t = now();
    for (const [k, r] of runs) if (r.state !== "running" && t - r.endedAt > keepMs) runs.delete(k);
  };

  return {
    start(conversationId, hookId, input, target) {
      sweep();
      const runId = randomUUID();
      const startedAt = now();
      const k = key(conversationId, runId);
      runs.set(k, { state: "running", hook: hookId, startedAt });
      void deps.run(conversationId, hookId, input, target).then(
        (out) => runs.set(k, { state: "done", hook: hookId, startedAt, endedAt: now(), outcome: toUserOutcome(out) }),
        (err: unknown) =>
          runs.set(k, {
            state: "error",
            hook: hookId,
            startedAt,
            endedAt: now(),
            error: String((err as Error)?.message ?? err),
          }),
      );
      return runId;
    },
    get(conversationId, runId) {
      return runs.get(key(conversationId, runId));
    },
  };
}
