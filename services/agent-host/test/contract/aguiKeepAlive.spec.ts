/**
 * The HTTP server keeps idle connections longer than the conversation-router's pool does
 * (30s), so the router never sends a prompt down a connection this server is closing.
 * Node's 5s default made that race routine: the router answered such a POST /agui with an
 * empty 200 and the prompt never ran.
 */

import { describe, it, expect } from "vitest";
import { request, Agent } from "node:http";

import { createAguiServer, KEEP_ALIVE_TIMEOUT_MS } from "../../src/agui/server.js";

/** The `Keep-Alive` header a keep-alive GET gets back. */
function keepAliveHeader(port: number): Promise<string | undefined> {
  const agent = new Agent({ keepAlive: true });
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/no-such-route", agent }, (res) => {
      res.resume();
      res.on("end", () => {
        agent.destroy();
        resolve(res.headers["keep-alive"] as string | undefined);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("agent-host HTTP keep-alive", () => {
  it("outlasts the router's 30s idle-connection timeout", () => {
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("the listening server advertises that timeout, not Node's 5s default", async () => {
    const server = createAguiServer();
    await server.listen(0);
    try {
      const header = await keepAliveHeader(server.port()!);
      expect(header).toBe(`timeout=${KEEP_ALIVE_TIMEOUT_MS / 1000}`);
    } finally {
      await server.close();
    }
  });
});
