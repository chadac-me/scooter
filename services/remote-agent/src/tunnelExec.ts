/**
 * The container's ExecBackend, which forwards the local Claude agent's tool calls to the
 * cloud over Channel B so tools run in the cloud sandbox. Each call sends an exec/fs frame
 * and awaits the cloud's exec_result (see protocol.ts).
 */

import { randomUUID } from "node:crypto";

import type { WireFrame } from "./protocol.js";

// The provider's own contract types, so a drift is a compile error.
import type {
  ExecBackend,
  ExecRequest,
  ExecResult,
  TerminalHandle,
} from "@scooter/claude-sdk-provider";

export type { ExecBackend, ExecRequest, ExecResult, TerminalHandle };

export interface TunnelExecDeps {
  /** Send a Channel-B frame to the cloud. */
  send(frame: WireFrame): void;
  /** Register for exec_result frames; returns unsubscribe. */
  onFrame(cb: (frame: WireFrame) => void): () => void;
}

export function createTunnelExecBackend(deps: TunnelExecDeps): ExecBackend {
  const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

  deps.onFrame((frame) => {
    if (frame.ch !== "exec" || frame.type !== "exec_result" || !frame.id) return;
    const p = pending.get(frame.id);
    if (!p) return;
    pending.delete(frame.id);
    const { result, error } = frame.payload as { result?: unknown; error?: string };
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  });

  const request = <R = unknown>(type: string, payload: unknown): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      deps.send({ ch: "exec", type, id, payload });
    });

  return {
    run(req) {
      return request<ExecResult>("exec_run", {
        command: req.command,
        args: req.args,
        cwd: req.cwd,
        env: req.env,
      });
    },
    // Streaming spawn is not tunnelled; this is a one-shot adapter over run().
    spawn(req) {
      const id = randomUUID();
      const outCbs = new Set<(c: string) => void>();
      const done = this.run(req).then((r) => {
        for (const cb of outCbs) cb(r.stdout + (r.stderr ?? ""));
        return { exitCode: r.exitCode };
      });
      return {
        id,
        onOutput: (cb) => {
          outCbs.add(cb);
        },
        waitForExit: () => done,
        kill: async () => {},
        // The remote run holds no resource, so releasing just drops the output listeners.
        release: async () => {
          outCbs.clear();
        },
      };
    },
    async readTextFile(path) {
      const r = await request<{ content: string }>("fs_read", { path });
      return r.content;
    },
    async writeTextFile(path, content) {
      await request("fs_write", { path, content });
    },
  };
}
