/**
 * kill_terminals interrupts the query of every brain it reaches, and one container serves
 * all of an owner's conversations. An unscoped kill from one conversation's Stop therefore
 * interrupted every other conversation mid-turn ("[Request interrupted by user]"), so a
 * kill naming a session must reach that session's brain only.
 */

import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { runRemoteAgentClient, type RemoteAgentClient } from "../src/remoteAgentClient.js";
import { registerBackend, BACKENDS } from "../src/agentBackend.js";
import type { WireFrame } from "../src/protocol.js";

/** A backend whose Nth brain issues session `acp-N` and counts the kills it receives. */
function countingBackend(id: string) {
  const kills = new Map<string, number>();
  let n = 0;
  registerBackend({
    id,
    needsClaudeAuth: false,
    async create() {
      const sid = `acp-${n++}`;
      kills.set(sid, 0);
      return {
        async initialize() { return { protocolVersion: 1 }; },
        async newSession() { return { sessionId: sid }; },
        async prompt() { return { stopReason: "end_turn" }; },
        async cancel() {},
        async killActiveTerminals() { kills.set(sid, (kills.get(sid) ?? 0) + 1); },
        isAlive() { return true; },
        onSessionUpdate() { return () => {}; },
        onTerminalCreated() { return () => {}; },
        onPermissionRequest() {},
        async close() {},
      } as never;
    },
  });
  return kills;
}

/** A cloud end that sends a frame and resolves with the container's ack for it. */
function cloud() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const ready = new Promise<string>((resolve) =>
    wss.on("listening", () => resolve(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`)),
  );
  const waiters = new Map<string, (f: WireFrame) => void>();
  let sock: ServerSocket | undefined;
  const connected = new Promise<void>((r) =>
    wss.on("connection", (s: ServerSocket) => {
      sock = s;
      s.on("message", (raw) => {
        const f = JSON.parse(String(raw)) as WireFrame;
        if (f.type === "ack" && f.id) waiters.get(f.id)?.(f);
      });
      r();
    }),
  );
  const call = async (type: string, id: string, payload: unknown): Promise<WireFrame> => {
    await connected;
    const acked = new Promise<WireFrame>((r) => waiters.set(id, r));
    sock!.send(JSON.stringify({ ch: "acp", type, id, payload }));
    return acked;
  };
  return { ready, call, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

let client: RemoteAgentClient | undefined;
let stopCloud: (() => Promise<void>) | undefined;
afterEach(async () => {
  client?.stop();
  await stopCloud?.();
  delete BACKENDS["counting"];
});

async function twoSessions() {
  const kills = countingBackend("counting");
  const c = cloud();
  stopCloud = c.close;
  client = runRemoteAgentClient({ url: await c.ready, joinToken: "t", backend: "counting", log: () => {} });
  await c.call("new_session", "ns-1", { params: { cwd: "/w" } });
  await c.call("new_session", "ns-2", { params: { cwd: "/w" } });
  return { kills, call: c.call };
}

describe("kill_terminals on a container shared by several conversations", () => {
  it("a kill naming a session reaches ONLY that session's brain", async () => {
    const { kills, call } = await twoSessions();
    await call("kill_terminals", "k-1", { sessionId: "acp-2" });
    expect(kills.get("acp-2")).toBe(1);
    expect(kills.get("acp-1"), "the other conversation's turn must not be interrupted").toBe(0);
  });

  it("an unscoped kill (a cloud predating scoping) still reaches every brain", async () => {
    const { kills, call } = await twoSessions();
    await call("kill_terminals", "k-1", {});
    expect(kills.get("acp-1")).toBe(1);
    expect(kills.get("acp-2")).toBe(1);
  });

  it("a kill for a session this container never issued is a no-op success", async () => {
    const { kills, call } = await twoSessions();
    const ack = await call("kill_terminals", "k-1", { sessionId: "acp-unknown" });
    expect((ack.payload as { error?: string } | undefined)?.error).toBeUndefined();
    expect([...kills.values()].every((k) => k === 0)).toBe(true);
  });
});
