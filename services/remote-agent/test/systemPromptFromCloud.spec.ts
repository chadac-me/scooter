/**
 * The container runs the prompt the CLOUD sent for the session, not a local stub.
 *
 * Nothing on this side builds the agent's identity: the container has no skills
 * directory and no copy of the agent-host's prompt, so whatever `new_session` carries IS
 * the agent's persona — and its `<title>` contract, without which a BYO conversation is
 * never named. The backend's hardcoded fallback makes that loss silent, so this test
 * pins the plumbing: new_session.params.systemPrompt reaches the backend verbatim.
 */

import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { runRemoteAgentClient, type RemoteAgentClient } from "../src/remoteAgentClient.js";
import { registerBackend, BACKENDS, type AgentBackendDeps } from "../src/agentBackend.js";
import type { WireFrame } from "../src/protocol.js";

/** A backend that records what it was created with and answers newSession. */
function recordingBackend(id: string) {
  const seen: AgentBackendDeps[] = [];
  registerBackend({
    id,
    needsClaudeAuth: false,
    async create(deps) {
      seen.push(deps);
      return {
        async initialize() { return { protocolVersion: 1 }; },
        async newSession() { return { sessionId: "acp-1" }; },
        async prompt() { return { stopReason: "end_turn" }; },
        async cancel() {},
        async killActiveTerminals() {},
        isAlive() { return true; },
        onSessionUpdate() { return () => {}; },
        onTerminalCreated() { return () => {}; },
        onPermissionRequest() {},
        async close() {},
      } as never;
    },
  });
  return seen;
}

/** Serve one WS connection, send `frames`, and resolve with every frame the container sent back. */
function cloud(frames: WireFrame[]) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const received: WireFrame[] = [];
  const ready = new Promise<string>((resolve) =>
    wss.on("listening", () => resolve(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`)),
  );
  let onAck: (() => void) | undefined;
  const acked = new Promise<void>((r) => (onAck = r));
  wss.on("connection", (sock: ServerSocket) => {
    sock.on("message", (raw) => {
      const f = JSON.parse(String(raw)) as WireFrame;
      received.push(f);
      if (f.type === "ack" && f.id === "req-new-session") onAck?.();
    });
    for (const f of frames) sock.send(JSON.stringify(f));
  });
  return { ready, received, acked, close: () => new Promise<void>((r) => wss.close(() => r())) };
}

const NEW_SESSION = (params: Record<string, unknown>): WireFrame => ({
  ch: "acp",
  type: "new_session",
  id: "req-new-session",
  payload: { params },
});

let client: RemoteAgentClient | undefined;
let stopCloud: (() => Promise<void>) | undefined;
afterEach(async () => {
  client?.stop();
  await stopCloud?.();
  delete BACKENDS["recording"];
});

/**
 * The deps of the brain built for the session. The container builds a PRIMARY brain up
 * front to answer `initialize`, before any session (and so any cloud prompt) exists; the
 * per-session brain is the next one, and the only one that ever serves a prompt.
 */
function sessionBrain(seen: AgentBackendDeps[]): AgentBackendDeps {
  expect(seen.length, "expected a primary brain plus one per-session brain").toBe(2);
  return seen[1];
}

/** Drive one new_session through a live container client and return the session brain's deps. */
async function backendDepsFor(params: Record<string, unknown>): Promise<AgentBackendDeps> {
  const seen = recordingBackend("recording");
  const c = cloud([NEW_SESSION(params)]);
  stopCloud = c.close;
  const url = await c.ready;
  client = runRemoteAgentClient({ url, joinToken: "t", backend: "recording", log: () => {} });
  await c.acked;
  return sessionBrain(seen);
}

describe("new_session carries the system prompt to the container's backend", () => {
  it("passes the cloud's prompt through verbatim", async () => {
    const prompt = "You are Scooter, an AI coding agent.\nEmit <title>…</title> first.";
    const deps = await backendDepsFor({ cwd: "/workspace", systemPrompt: prompt });
    expect(deps.systemPrompt).toBe(prompt);
  });

  it("the cloud's prompt WINS over the container's own --system-prompt", async () => {
    // The cloud owns the persona; a container flag must not strip the <title> contract.
    const seen = recordingBackend("recording");
    const c = cloud([NEW_SESSION({ cwd: "/workspace", systemPrompt: "from the cloud" })]);
    stopCloud = c.close;
    const url = await c.ready;
    client = runRemoteAgentClient({
      url,
      joinToken: "t",
      backend: "recording",
      systemPrompt: "local override",
      log: () => {},
    });
    await c.acked;
    expect(sessionBrain(seen).systemPrompt).toBe("from the cloud");
  });

  it("falls back to the container's own prompt when the cloud sends none", async () => {
    const seen = recordingBackend("recording");
    const c = cloud([NEW_SESSION({ cwd: "/workspace" })]);
    stopCloud = c.close;
    const url = await c.ready;
    client = runRemoteAgentClient({
      url,
      joinToken: "t",
      backend: "recording",
      systemPrompt: "local only",
      log: () => {},
    });
    await c.acked;
    expect(sessionBrain(seen).systemPrompt).toBe("local only");
  });

  it("logs loudly when NO prompt is available, since the stub identity is a silent loss", async () => {
    recordingBackend("recording");
    const c = cloud([NEW_SESSION({ cwd: "/workspace" })]);
    stopCloud = c.close;
    const url = await c.ready;
    const lines: string[] = [];
    client = runRemoteAgentClient({
      url,
      joinToken: "t",
      backend: "recording",
      log: (m) => lines.push(m),
    });
    await c.acked;
    expect(lines.join("\n")).toMatch(/system prompt: NONE/);
  });
});
