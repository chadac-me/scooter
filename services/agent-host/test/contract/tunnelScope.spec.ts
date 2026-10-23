/**
 * One BYOC container serves every conversation its owner has, and the controller fans
 * that session's inbound stream to every reader, replaying its queue to a new or
 * reconnected one. Each conversation's tunnel client must serve only its own ACP
 * session's frames, and each stream once (2026-10-22: job notices and a github_comment
 * landed in the wrong conversations; comments were re-posted after a broker restart).
 */

import { describe, it, expect } from "vitest";

import { createTunnelFrameFilter, startTunnelClient } from "../../src/acp/tunnelClient.js";
import type { WireFrame } from "../../src/acp/remoteProtocol.js";

const open = (id: string, sid?: string): WireFrame => ({
  ch: "tunnel", type: "open", id, ...(sid ? { sid } : {}),
  payload: { target: "scooter-env", method: "POST", path: "/mcp", headers: {} },
});
const end = (id: string, sid?: string): WireFrame => ({ ch: "tunnel", type: "end", id, ...(sid ? { sid } : {}), payload: {} });

describe("tunnel frame filter", () => {
  it("admits only this conversation's ACP sessions", () => {
    const admit = createTunnelFrameFilter((sid) => sid === "acp-a");
    expect(admit(open("s1", "acp-a"))).toBe(true);
    expect(admit(open("s2", "acp-b"))).toBe(false);
  });

  it("refuses an unstamped frame rather than guess its scope", () => {
    const admit = createTunnelFrameFilter((sid) => sid === "acp-a");
    expect(admit(open("s1"))).toBe(false);
  });

  it("serves a stream's open once, so a replayed queue re-runs nothing", () => {
    const admit = createTunnelFrameFilter((sid) => sid === "acp-a");
    expect(admit(open("s1", "acp-a"))).toBe(true);
    expect(admit(end("s1", "acp-a"))).toBe(true);
    expect(admit(open("s1", "acp-a"))).toBe(false);
  });
});

/** A controller whose inbound stream replays `frames` on every connection, and an MCP target that records calls. */
function harness(frames: WireFrame[]) {
  const mcpCalls: string[] = [];
  let connections = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/tunnel") && !init?.method) {
      connections++;
      const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close(); // the reader redials, and the controller replays the queue
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (u.includes("/tunnel/")) return new Response(null, { status: 204 });
    mcpCalls.push(u);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, mcpCalls, connections: () => connections };
}

const follow = (conv: string, ownsSession: (sid: string) => boolean, fetchImpl: typeof fetch) =>
  startTunnelClient({
    baseUrl: "http://controller:8080",
    sessionId: "container-1",
    conversationId: conv,
    mcpUrlFor: (c: string) => `http://mcp.local/mcp?conv=${c}`,
    fetchImpl,
    ownsSession,
  });

const until = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
};

describe("two conversations on one container stream", () => {
  it("THE BUG: each runs only its own tool call, in its own scope @proves", async () => {
    const h = harness([open("s-a", "acp-a"), end("s-a", "acp-a"), open("s-b", "acp-b"), end("s-b", "acp-b")]);
    const a = follow("conv-a", (s) => s === "acp-a", h.fetchImpl);
    const b = follow("conv-b", (s) => s === "acp-b", h.fetchImpl);
    try {
      await until(() => h.mcpCalls.length >= 2);
      expect(h.mcpCalls.sort()).toEqual(["http://mcp.local/mcp?conv=conv-a", "http://mcp.local/mcp?conv=conv-b"]);
    } finally {
      a.close();
      b.close();
    }
  });

  it("THE BUG: a reconnect's replayed queue re-runs no tool call @proves", async () => {
    const h = harness([open("s-a", "acp-a"), end("s-a", "acp-a")]);
    const a = follow("conv-a", (s) => s === "acp-a", h.fetchImpl);
    try {
      await until(() => h.connections() >= 2, 5000);
      await new Promise((r) => setTimeout(r, 100));
      expect(h.connections()).toBeGreaterThanOrEqual(2);
      expect(h.mcpCalls).toEqual(["http://mcp.local/mcp?conv=conv-a"]);
    } finally {
      a.close();
    }
  }, 10_000);
});
