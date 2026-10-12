/**
 * RemoteAcpClient: the cloud side of bring-your-own-Claude, an AcpClient whose brain
 * runs in the user's container. ACP requests go down the wire and await the
 * correlated `ack`, the agent's notifications come up and dispatch to the bridge's
 * callbacks, and the agent's tool calls (channel B) are served here against the
 * cloud ExecBackend, so tools run in the cloud sandbox while the model runs on the laptop.
 */

import { randomUUID } from "node:crypto";

import type { AcpClient, PermissionRequest, SessionUpdate, PermissionAnswer } from "./client.js";
import type { ExecBackend, ExecResult } from "../types.js";
import {
  type RemoteTransport,
  type WireFrame,
  type AcpAckPayload,
  type AcpSessionUpdatePayload,
  type AcpTerminalCreatedPayload,
  type AcpPermissionRequestPayload,
  type ExecRunPayload,
  type FsReadPayload,
  type FsWritePayload,
} from "./remoteProtocol.js";

export interface RemoteAcpClientDeps {
  /** The duplex frame transport to the container. */
  transport: RemoteTransport;
  /** The cloud sandbox ExecBackend that services the agent's tunneled tool calls. */
  exec: ExecBackend;
}

export function createRemoteAcpClient(deps: RemoteAcpClientDeps): AcpClient {
  const { transport, exec } = deps;

  // Pending ACP requests awaiting their `ack`, by frame id.
  const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  const updateCbs = new Set<(sessionId: string, u: SessionUpdate) => void>();
  const terminalCbs = new Set<(terminalId: string, command: string, args: string[]) => void>();
  let permissionHandler: ((req: PermissionRequest) => Promise<PermissionAnswer>) | undefined;
  let closed = false;

  const failAllPending = (reason: string) => {
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
  };

  transport.onClose(() => {
    closed = true;
    // Reject in-flight requests so the bridge surfaces a RUN_ERROR rather than a silent stall.
    failAllPending("remote agent disconnected");
  });

  // Send an ACP request down the wire and await its ack.
  const request = <R = unknown>(type: string, payload: unknown): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      if (closed || !transport.isOpen()) {
        reject(new Error("remote agent not connected"));
        return;
      }
      const id = randomUUID();
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      transport.send({ ch: "acp", type, id, payload });
    });

  // Reply to a Channel-B exec/fs request from the agent.
  const reply = (id: string, type: string, payload: unknown) =>
    transport.send({ ch: "exec", type, id, payload });

  // --- inbound frame dispatch ---------------------------------------------------------------
  transport.onFrame((frame: WireFrame) => {
    if (frame.ch === "acp") {
      switch (frame.type) {
        case "ack": {
          const p = frame.id ? pending.get(frame.id) : undefined;
          if (!p || !frame.id) return;
          pending.delete(frame.id);
          const { result, error } = frame.payload as AcpAckPayload;
          if (error) p.reject(new Error(error));
          else p.resolve(result);
          return;
        }
        case "session_update": {
          const { sessionId, update } = frame.payload as AcpSessionUpdatePayload;
          for (const cb of updateCbs) cb(sessionId, update);
          return;
        }
        case "terminal_created": {
          const { terminalId, command, args } = frame.payload as AcpTerminalCreatedPayload;
          for (const cb of terminalCbs) cb(terminalId, command, args);
          return;
        }
        case "permission_request": {
          const { request: req } = frame.payload as AcpPermissionRequestPayload;
          const id = frame.id;
          // With no handler wired, cancel; otherwise ask the UI and reply over the same id.
          void (permissionHandler ? permissionHandler(req) : Promise.resolve<PermissionAnswer>({ cancelled: true }))
            .then((ans) => {
              if (id) reply2(id, ans);
            })
            .catch(() => {
              if (id) reply2(id, { cancelled: true });
            });
          return;
        }
      }
      return;
    }
    // Channel B: the agent's tool calls, served on the cloud ExecBackend.
    if (frame.ch === "exec" && frame.id) void serveExec(frame);
    // Tunnel frames arrive on the controller's dedicated inbound stream (tunnelClient.ts), never here.
  });

  // Permission answers go back on the ACP channel against the permission_request `id`.
  const reply2 = (id: string, ans: PermissionAnswer) =>
    transport.send({ ch: "acp", type: "ack", id, payload: { result: ans } });

  // Run one channel-B exec/fs request against the cloud ExecBackend and reply.
  const serveExec = async (frame: WireFrame) => {
    const id = frame.id!;
    try {
      switch (frame.type) {
        case "exec_run": {
          const p = frame.payload as ExecRunPayload;
          const res: ExecResult = await exec.run({
            command: p.command,
            args: p.args ?? [],
            cwd: p.cwd,
            env: p.env,
          });
          reply(id, "exec_result", { result: res });
          return;
        }
        case "fs_read": {
          const content = await exec.readTextFile((frame.payload as FsReadPayload).path);
          reply(id, "exec_result", { result: { content } });
          return;
        }
        case "fs_write": {
          const p = frame.payload as FsWritePayload;
          await exec.writeTextFile(p.path, p.content);
          reply(id, "exec_result", { result: {} });
          return;
        }
        // exec_spawn (a streaming terminal) is unsupported; reply with an error so the agent falls back.
        default:
          reply(id, "exec_result", { error: `unsupported exec request: ${frame.type}` });
      }
    } catch (err) {
      reply(id, "exec_result", { error: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    async initialize(params) {
      return (await request("initialize", { params })) as { protocolVersion: number };
    },
    async newSession(params) {
      return (await request("new_session", { params })) as { sessionId: string };
    },
    async prompt(params) {
      return (await request("prompt", { sessionId: params.sessionId, prompt: params.prompt })) as {
        stopReason: string;
      };
    },
    async cancel(sessionId) {
      await request("cancel", { sessionId });
    },
    async killActiveTerminals(_graceForPendingSpawn = false) {
      // A disconnected agent has no terminals to kill.
      if (closed || !transport.isOpen()) return;
      await request("kill_terminals", {}).catch(() => {});
    },
    isAlive() {
      return !closed && transport.isOpen();
    },
    onSessionUpdate(cb) {
      updateCbs.add(cb);
      return () => updateCbs.delete(cb);
    },
    onTerminalCreated(cb) {
      terminalCbs.add(cb);
      return () => terminalCbs.delete(cb);
    },
    onPermissionRequest(handler) {
      permissionHandler = handler;
    },
    async close() {
      closed = true;
      failAllPending("client closed");
      transport.close();
    },
  };
}
