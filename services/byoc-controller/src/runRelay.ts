/**
 * The BYOC run relay: one prompt in, a stream of ACP frames out.
 *
 *   agent-host --POST /byoc/:session/prompt--> [relay] --WS--> container
 *   agent-host <----------- SSE (ACP frames) --[relay] <--WS-- container
 *
 * The agent-host holds nothing, so any replica can serve any conversation; the controller
 * owns the single duplex WS to the container and forwards frames and correlates ids. The
 * invariant is that every stream terminates: a lost ack, a mis-correlated id or a dropped
 * socket must each end the affected stream with a terminal frame.
 */

import { randomUUID } from "node:crypto";

import type { SessionRegistry } from "./sessionRegistry.js";
import type { AcpPromptPayload, ExecResultPayload, WireFrame } from "./remoteProtocol.js";

/** The user's decision on a permission request. */
export type PermissionAnswer = { optionId: string } | { cancelled: true };

export type AnswerResult = { ok: true } | { ok: false; reason: string };

export interface RunRelayConfig {
  registry: SessionRegistry;
}

export interface RunRelay {
  /** Send a prompt and stream this run's frames back, rejecting rather than hanging if the container is not reachable. */
  prompt(sessionId: string, payload: AcpPromptPayload, callerId?: string): AsyncIterable<WireFrame>;
  /** Send any ACP request and stream the reply, with `callerId` (the caller's frame id) round-tripped onto the ack so the caller's by-id correlation resolves. */
  request(sessionId: string, type: string, payload: unknown, callerId?: string): AsyncIterable<WireFrame>;
  /** Answer a permission the container is blocked on. */
  answerPermission(sessionId: string, permissionId: string, answer: PermissionAnswer): AnswerResult;
  /** Return an exec/fs result the agent-host ran on its own ExecBackend. */
  answerExec(sessionId: string, execId: string, payload: ExecResultPayload): AnswerResult;
  /** Forward a tunnel frame from the agent-host down to the container; a tunnel stream is not a run and bypasses the run bookkeeping. */
  answerTunnel(sessionId: string, streamId: string, frame: WireFrame): AnswerResult;
  /** Subscribe to container-to-cloud tunnel frames, which are kept out of run streams; returns unsubscribe. */
  onTunnelFrame(cb: (sessionId: string, frame: WireFrame) => void): () => void;
  /** Feed a raw frame received from a container's socket. */
  onContainerFrame(sessionId: string, raw: string): void;
  /** The container's socket closed, so terminate every run still waiting on it. */
  onContainerGone(sessionId: string): void;
}

/** One in-flight run: a queue of frames plus whoever is waiting to read the next one. */
interface PendingRun {
  sessionId: string;
  /** The ACP session this run drives; undefined for the handshake calls, which produce no notifications. */
  acpSessionId?: string;
  /** The caller's frame id, which the ack yielded back up is rewritten to. */
  callerId?: string;
  queue: WireFrame[];
  waiter?: (frame: WireFrame | null) => void;
  done: boolean;
}

export function createRunRelay(config: RunRelayConfig): RunRelay {
  const { registry } = config;
  // requestId -> the run awaiting frames, keyed by the id put on the wire so a frame is delivered only to the run whose id it carries.
  const runs = new Map<string, PendingRun>();
  // Requests the container is blocked on (permission and exec ids), kept per-session so a disconnect can abandon them wholesale.
  const awaiting = new Map<string, { sessionId: string; kind: "permission" | "exec" }>();
  // Container sessions already warned about unattributable frames.
  const warnedLegacy = new Set<string>();
  // Subscribers for container-to-cloud tunnel frames.
  const tunnelCbs = new Set<(sessionId: string, frame: WireFrame) => void>();

  const push = (run: PendingRun, frame: WireFrame): void => {
    if (run.done) return;
    // The ack carries the relay's requestId, so rewrite it to the id the caller correlates by; notifications pass through untouched.
    if (run.callerId && frame.type === "ack") {
      frame = { ...frame, id: run.callerId };
    }
    if (run.waiter) {
      const w = run.waiter;
      run.waiter = undefined;
      w(frame);
    } else {
      run.queue.push(frame);
    }
  };

  /** End a run: deliver a terminal frame, then release any reader with null to end the iterator. */
  const finish = (requestId: string, terminal: WireFrame): void => {
    const run = runs.get(requestId);
    if (!run || run.done) return;
    push(run, terminal);
    run.done = true;
    runs.delete(requestId);
    if (run.waiter) {
      const w = run.waiter;
      run.waiter = undefined;
      w(null);
    }
  };

  /** Send a reply down to the container for a request it is blocked on, rejecting an unknown or already-answered id. */
  const replyToContainer = (
    sessionId: string,
    id: string,
    kind: "permission" | "exec",
    frame: WireFrame,
  ): AnswerResult => {
    const entry = awaiting.get(id);
    // Unknown covers a late answer after a restart, a duplicate POST and an id from a dropped connection, all of which must fail cleanly.
    if (!entry || entry.sessionId !== sessionId || entry.kind !== kind) {
      return { ok: false, reason: `unknown ${kind} ${id}` };
    }
    const session = registry.resolveBySession(sessionId);
    if (!session?.socket) return { ok: false, reason: "container not connected" };
    // Delete before sending so a concurrent duplicate cannot also pass the check above.
    awaiting.delete(id);
    try {
      session.socket.send(JSON.stringify(frame));
    } catch (err) {
      return { ok: false, reason: `send failed: ${String(err)}` };
    }
    return { ok: true };
  };

  return {
    prompt(sessionId, payload, callerId) {
      return this.request(sessionId, "prompt", payload, callerId);
    },

    request(sessionId, type, payload, callerId) {
      // Validate against the live socket before returning the iterable so a dead session fails fast.
      const session = registry.resolveBySession(sessionId);
      const requestId = randomUUID();
      // The ACP session this run drives, the routing key that delivers notifications and tool calls to their run only.
      // Only a prompt drives a session: a cancel or kill_terminals naming the same session must not receive a copy of the
      // running prompt's frames, or the agent-host sees every update twice and services each exec request twice.
      const acpSessionId = type === "prompt" ? (payload as { sessionId?: string } | undefined)?.sessionId : undefined;
      const run: PendingRun = { sessionId, queue: [], done: false, callerId, acpSessionId };

      let failure: string | undefined;
      if (!session) failure = `unknown session ${sessionId}`;
      else if (!session.socket) failure = `container not connected (session ${sessionId} is offline)`;

      if (!failure && session?.socket) {
        runs.set(requestId, run);
        const frame: WireFrame = { ch: "acp", type, id: requestId, payload };
        try {
          session.socket.send(JSON.stringify(frame));
        } catch (err) {
          runs.delete(requestId);
          failure = `send failed: ${String(err)}`;
        }
      }

      return {
        async *[Symbol.asyncIterator]() {
          if (failure) throw new Error(failure);
          for (;;) {
            if (run.queue.length) {
              yield run.queue.shift()!;
              continue;
            }
            if (run.done) return;
            const next = await new Promise<WireFrame | null>((resolve) => {
              run.waiter = resolve;
            });
            if (next === null) return;
            yield next;
          }
        },
      };
    },

    onContainerFrame(sessionId, raw) {
      let frame: WireFrame;
      try {
        frame = JSON.parse(raw) as WireFrame;
      } catch {
        return; // a malformed frame is dropped rather than killing the socket
      }
      // Tunnel frames go to their subscribers only, never into a run's transcript.
      if (frame.ch === "tunnel") {
        for (const cb of [...tunnelCbs]) cb(sessionId, frame);
        return;
      }
      if (frame.type === "ack" && frame.id) {
        // The ack terminates its run whether it carries a result or an error.
        finish(frame.id, frame);
        return;
      }
      // A permission_request or exec frame means the container is blocked on a reply; record it so the reply routes and a duplicate is rejected.
      if (frame.id && (frame.type === "permission_request" || frame.type.startsWith("exec_") || frame.type.startsWith("fs_"))) {
        awaiting.set(frame.id, { sessionId, kind: frame.type === "permission_request" ? "permission" : "exec" });
      }
      // Route to the run the frame belongs to, keyed by the frame-level sid, then the payload's sessionId, then a permission_request's request.sessionId.
      const payload = frame.payload as
        | { sessionId?: string; request?: { sessionId?: string } }
        | undefined;
      const key = frame.sid ?? payload?.sessionId ?? payload?.request?.sessionId;
      const candidates = [...runs.values()].filter((r) => r.sessionId === sessionId);
      if (key) {
        const matched = candidates.filter((r) => r.acpSessionId === key);
        // A keyed frame with no matching run is dropped rather than put in the wrong conversation.
        for (const run of matched) push(run, frame);
        return;
      }
      // An unkeyed frame is exact with one run in flight and ambiguous with more, where it is broadcast with a one-time warning.
      if (candidates.length > 1 && !warnedLegacy.has(sessionId)) {
        warnedLegacy.add(sessionId);
        // eslint-disable-next-line no-console
        console.warn(
          `[byoc] session ${sessionId}: unkeyed ${frame.type} with ${candidates.length} concurrent runs — ` +
            `an old container image cannot attribute tool calls; upgrade it for safe concurrency`,
        );
      }
      for (const run of candidates) push(run, frame);
    },

    answerPermission(sessionId, permissionId, answer) {
      return replyToContainer(sessionId, permissionId, "permission", { ch: "acp", type: "ack", id: permissionId, payload: answer });
    },

    answerTunnel(sessionId, streamId, frame) {
      const session = registry.resolveBySession(sessionId);
      if (!session?.socket) {
        // Fail rather than drop, so the container's SDK sees a failing tool call instead of a hanging one.
        return { ok: false, reason: `container not connected (session ${sessionId})` };
      }
      try {
        session.socket.send(JSON.stringify(frame));
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `send failed: ${String(err)}` };
      }
    },

    onTunnelFrame(cb) {
      tunnelCbs.add(cb);
      return () => tunnelCbs.delete(cb);
    },

    answerExec(sessionId, execId, payload) {
      return replyToContainer(sessionId, execId, "exec", { ch: "exec", type: "exec_result", id: execId, payload });
    },

    onContainerGone(sessionId) {
      // Abandon everything this container was blocked on, so a reconnected container cannot receive replies to the previous connection's work.
      for (const [id, entry] of [...awaiting]) {
        if (entry.sessionId === sessionId) awaiting.delete(id);
      }
      // Terminate every run on this container, or the agent-host waits forever.
      for (const [requestId, run] of [...runs]) {
        if (run.sessionId !== sessionId) continue;
        finish(requestId, {
          ch: "acp",
          type: "ack",
          id: requestId,
          payload: { error: "container disconnected mid-run" },
        });
      }
    },
  };
}
