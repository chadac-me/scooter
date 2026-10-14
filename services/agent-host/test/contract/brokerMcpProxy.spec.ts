import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createBrokerMcpProxy } from "../../src/agent/brokerMcpProxy.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** A real HTTP server fronting the proxy, pointed at `brokerMcpUrl`. */
async function proxyTo(brokerMcpUrl: string): Promise<string> {
  const proxy = createBrokerMcpProxy({
    baseUrl: "http://unused",
    brokerMcpUrl,
    resolveConversation: () => "conv-1",
    mintConvToken: () => "tok",
    saToken: async () => undefined,
  });
  server = createServer((req, res) => void proxy.handle(req, res, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe("broker MCP proxy", () => {
  it("tells the agent WHY the broker is unreachable", async () => {
    const url = await proxyTo(`http://127.0.0.1:${await closedPort()}/mcp`);
    const res = await fetch(url, { method: "POST" });
    const body = await res.text();
    expect(res.status).toBe(502);
    expect(body).not.toContain("[object Object]");
    expect(body).toContain("ECONNREFUSED");
  });
});
