/** Conversation hooks: sandbox scripts speaking Claude Code's hook protocol. */

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** One row of AGENT_HOOKS_JSON. */
export interface HookDef {
  /** Stable: user opt-outs are keyed by it. */
  id: string;
  event: HookEvent;
  /** Anchored regex over tool name or session source. */
  matcher: string;
  /** Bash script; the event JSON arrives on stdin. */
  command: string;
  timeoutSec: number;
  /** A crash or timeout blocks instead of being skipped. */
  failClosed: boolean;
  userCanDisable: boolean;
  description: string;
}

export interface HookRunRecord {
  id: string;
  event: HookEvent;
  decision: "allow" | "block" | "error" | "stop";
  ms: number;
  error?: string;
}

/** Every matching hook's answer, merged. */
export interface HookOutcome {
  /** Why the action is refused (a block or deny). */
  block?: string;
  updatedInput?: Record<string, unknown>;
  /** For the model (`additionalContext`). */
  context: string[];
  /** For the user (`systemMessage`). */
  systemMessages: string[];
  /** A hook ended the turn outright (`continue: false`). */
  stop?: string;
  runs: HookRunRecord[];
}

/** Fires one conversation's hooks. */
export interface HookRunner {
  /** Whether any enabled hook subscribes to `event`. */
  has(event: HookEvent): Promise<boolean>;
  run(event: HookEvent, input: Record<string, unknown>, target?: string, signal?: AbortSignal): Promise<HookOutcome>;
}
