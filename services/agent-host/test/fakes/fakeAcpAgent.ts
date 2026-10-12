/**
 * In-process fake ACP agent for the unit tests. Given a script, it emits
 * session/update notifications and permission requests through an in-process
 * transport that the AcpClient invokes directly, so the bridge's AG-UI output
 * can be asserted deterministically.
 */

import type { SessionUpdate, PermissionRequest } from "../../src/acp/client.js";

export type ScriptStep =
  | { emit: SessionUpdate }
  | { callTerminal: { command: string; args: string[] } }
  | { callFsRead: { path: string } }
  | { callFsWrite: { path: string; content: string } }
  | { requestPermission: Omit<PermissionRequest, "sessionId"> }
  | { finish: { stopReason: string } };

/** The transport side the AcpClient talks to; the fake plays its script when `prompt` is called. */
export interface FakeAcpTransport {
  initialize(): Promise<{ protocolVersion: number }>;
  newSession(): Promise<{ sessionId: string }>;
  prompt(
    sessionId: string,
    handlers: {
      onUpdate: (u: SessionUpdate) => void;
      onPermission?: (r: PermissionRequest) => Promise<{ optionId: string }>;
    },
  ): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void>;
  /** Lets a cancel test assert active terminals were killed. */
  killActiveTerminals?(): Promise<void>;
  /** Liveness signal for the bridge's watchdog; absent means alive. */
  isAlive?(): boolean;
  /** Subscribe to terminal/create, driven by FakeAcpAgent.terminalCreated(). */
  onTerminalCreated?(cb: (terminalId: string, command: string, args: string[]) => void): void;
  close(): Promise<void>;
}

export interface FakeAcpAgent {
  setScript(steps: ScriptStep[]): void;
  readonly transport: FakeAcpTransport;
  /** Hold every prompt in flight until releaseGate(); `ignoreCancel` models an agent stalled in a model call that only releaseGate() frees. */
  gate(opts?: { ignoreCancel?: boolean }): void;
  releaseGate(): void;
  /** Number of times killActiveTerminals was called. */
  killCount(): number;
  /** Number of prompts that have entered prompt(). */
  startedCount(): number;
  /** Flip isAlive() to false without releasing a gated prompt, as a dead process would. */
  die(): void;
  /** Flip isAlive() back to true after die(). */
  heal(): void;
  /** Make the next prompt reject with `message` once it is released. */
  failNext(message: string): void;
  /** Push a session update to the currently running prompt's onUpdate. */
  emit(u: SessionUpdate): void;
  /** Fire the bridge's onTerminalCreated as goose's terminal/create would. */
  terminalCreated(terminalId: string, command: string, args: string[]): void;
  close(): void;
}

export function createFakeAcpAgent(): FakeAcpAgent {
  let script: ScriptStep[] = [];
  let sessionCounter = 0;
  let gated = false;
  let gateIgnoresCancel = false;
  let releaseGateFn: (() => void) | undefined;
  let kills = 0;
  let starts = 0;
  let alive = true;
  let failWith: string | undefined;
  const cancelledSessions = new Set<string>();
  // The live onUpdate of the currently running prompt, exposed via emit().
  let liveUpdate: ((u: SessionUpdate) => void) | undefined;
  const terminalCreatedCbs = new Set<(terminalId: string, command: string, args: string[]) => void>();

  const transport: FakeAcpTransport = {
    async initialize() {
      return { protocolVersion: 1 };
    },
    async newSession() {
      sessionCounter += 1;
      return { sessionId: `fake-session-${sessionCounter}` };
    },
    async prompt(sessionId, handlers) {
      starts += 1;
      liveUpdate = handlers.onUpdate;
      let stopReason = "end_turn";
      for (const step of script) {
        if ("emit" in step) {
          handlers.onUpdate(step.emit);
        } else if ("requestPermission" in step) {
          if (handlers.onPermission) {
            await handlers.onPermission({ sessionId, ...step.requestPermission });
          }
        } else if ("finish" in step) {
          stopReason = step.finish.stopReason;
        }
        // callTerminal / callFsRead / callFsWrite steps are not played by this fake.
      }
      if (gated) {
        await new Promise<void>((res) => { releaseGateFn = res; });
      }
      // Consume the cancel flag either way so it cannot leak into a later prompt.
      const wasCancelled = cancelledSessions.delete(sessionId);
      // A rejection wins over a cancel.
      if (failWith !== undefined) {
        const message = failWith;
        failWith = undefined;
        throw new Error(message);
      }
      if (wasCancelled) stopReason = "cancelled";
      return { stopReason };
    },
    async cancel(sessionId: string) {
      cancelledSessions.add(sessionId);
      // A stalled-agent gate ignores the cancel and keeps prompt() pending.
      if (gateIgnoresCancel) return;
      releaseGateFn?.();
      releaseGateFn = undefined;
    },
    async killActiveTerminals() {
      kills += 1;
    },
    isAlive() {
      return alive;
    },
    onTerminalCreated(cb) {
      terminalCreatedCbs.add(cb);
    },
    async close() {
      /* no-op */
    },
  };

  return {
    setScript(steps) {
      script = steps;
    },
    transport,
    gate(opts) {
      gated = true;
      gateIgnoresCancel = opts?.ignoreCancel === true;
    },
    releaseGate() {
      gated = false;
      gateIgnoresCancel = false;
      releaseGateFn?.();
      releaseGateFn = undefined;
    },
    killCount() {
      return kills;
    },
    startedCount() {
      return starts;
    },
    failNext(message: string) {
      failWith = message;
    },
    die() {
      alive = false;
    },
    heal() {
      alive = true;
    },
    emit(u: SessionUpdate) {
      liveUpdate?.(u);
    },
    terminalCreated(terminalId, command, args) {
      for (const cb of terminalCreatedCbs) cb(terminalId, command, args);
    },
    close() {
      script = [];
    },
  };
}
