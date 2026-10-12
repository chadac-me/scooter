/**
 * The ACP client-method handlers that service Goose's fs/* and terminal/* callbacks
 * against the ExecBackend, kept separate from client.ts so they can be unit-tested
 * without spawning a `goose acp` subprocess. Terminal bookkeeping (a handle map and an
 * output-buffer map) is keyed by the ExecBackend handle's id, which is unique per
 * spawn, so concurrent terminals never collide.
 */

import type * as schema from "@zed-industries/agent-client-protocol";

import type { ExecBackend } from "../types.js";
import { debug } from "../debug.js";

import { logger } from "../log.js";

const log = logger("sandboxHandlers");

/** The subset of ACP Client methods that map onto the ExecBackend. */
export interface SandboxClientHandlers {
  readTextFile(p: schema.ReadTextFileRequest): Promise<schema.ReadTextFileResponse>;
  writeTextFile(p: schema.WriteTextFileRequest): Promise<schema.WriteTextFileResponse>;
  createTerminal(p: schema.CreateTerminalRequest): Promise<schema.CreateTerminalResponse>;
  terminalOutput(p: schema.TerminalOutputRequest): Promise<schema.TerminalOutputResponse>;
  waitForTerminalExit(
    p: schema.WaitForTerminalExitRequest,
  ): Promise<schema.WaitForTerminalExitResponse>;
  releaseTerminal(
    p: schema.ReleaseTerminalRequest,
  ): Promise<schema.ReleaseTerminalResponse | void>;
  killTerminal(p: schema.KillTerminalCommandRequest): Promise<schema.KillTerminalResponse | void>;
  /** Best-effort kill of every live terminal for this session. */
  killAllTerminals(graceForPendingSpawn?: boolean): Promise<void>;
}

export function createSandboxClientHandlers(
  exec: ExecBackend,
  // Notified when goose creates a terminal, the only place the command text is available,
  // so the bridge can surface it as the tool call's args.
  onTerminalCreated?: (terminalId: string, command: string, args: string[]) => void,
): SandboxClientHandlers {
  /** How long a user stop that lands before its terminal exists is held for the next terminal; armed only for a user stop, since an internal preemption's replacement shell must survive. */
  const CANCEL_GRACE_MS = 2_000;
  let cancelDeadline = 0;
  const terminals = new Map<string, ReturnType<ExecBackend["spawn"]>>();
  const terminalBuffers = new Map<string, string>();

  return {
    async readTextFile(params) {
      const content = await exec.readTextFile(params.path);
      return { content };
    },

    async writeTextFile(params) {
      await exec.writeTextFile(params.path, params.content);
      return {};
    },

    async createTerminal(params) {
      debug("[acp] createTerminal:", JSON.stringify({ command: params.command, args: params.args, cwd: params.cwd }));
      // goose passes its own session cwd, which does not exist in the sandbox, so run in
      // the workspace unless goose gave a path under /workspace.
      const sandboxCwd =
        params.cwd && params.cwd.startsWith("/workspace") ? params.cwd : "/workspace";
      const handle = exec.spawn({
        command: params.command,
        args: params.args ?? [],
        cwd: sandboxCwd,
        env: Object.fromEntries((params.env ?? []).map((e) => [e.name, e.value])),
      });
      terminals.set(handle.id, handle);
      if (Date.now() < cancelDeadline) {
        // A cancel landed while this terminal was still starting, so kill it now; one
        // missed cancel kills one terminal.
        cancelDeadline = 0;
        log.info("killing a terminal that started after a cancel", { terminal_id: handle.id });
        void handle.kill().catch(() => {});
      }
      // Accumulate streamed output so terminalOutput() can read it.
      terminalBuffers.set(handle.id, "");
      handle.onOutput((chunk) => {
        terminalBuffers.set(handle.id, (terminalBuffers.get(handle.id) ?? "") + chunk);
      });
      // Surface the original command/args goose requested so the bridge can attribute
      // them to the tool call.
      onTerminalCreated?.(handle.id, params.command, params.args ?? []);
      return { terminalId: handle.id };
    },

    async terminalOutput(params) {
      const buf = terminalBuffers.get(params.terminalId) ?? "";
      debug("[acp] terminalOutput:", params.terminalId, JSON.stringify(buf.slice(0, 200)));
      return { output: buf, truncated: false };
    },

    async waitForTerminalExit(params) {
      const handle = terminals.get(params.terminalId);
      if (!handle) {
        // An unknown terminalId is a host bug, not a command outcome, so throw a
        // protocol error rather than fabricate an exit code.
        throw new Error(`waitForTerminalExit: unknown terminalId ${params.terminalId}`);
      }
      const { exitCode } = await handle.waitForExit();
      return { exitCode };
    },

    async releaseTerminal(params) {
      await terminals.get(params.terminalId)?.release();
      terminals.delete(params.terminalId);
      terminalBuffers.delete(params.terminalId);
    },

    async killTerminal(params) {
      await terminals.get(params.terminalId)?.kill();
    },

    async killAllTerminals(graceForPendingSpawn = false) {
      // Kill every live terminal concurrently, and when there is nothing to kill arm the
      // grace window since the shell this cancel was aimed at is probably still spawning.
      if (graceForPendingSpawn && terminals.size === 0) cancelDeadline = Date.now() + CANCEL_GRACE_MS;
      log.info("killAllTerminals", { terminal_count: terminals.size, grace: graceForPendingSpawn });
      await Promise.allSettled([...terminals.values()].map((h) => h.kill()));
    },
  };
}
