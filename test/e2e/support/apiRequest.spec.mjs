import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "@playwright/test";
import { apiRequestHeaders, newApiRequestContext } from "./apiRequest.mjs";

const IDLE_MS = 150;

/**
 * An HTTP/1.1 server whose idle close never reaches the client (nginx behind a
 * port-forward): a request on a socket idle past IDLE_MS is answered with a reset.
 */
function staleSocketServer() {
  const state = { connections: 0 };
  const server = net.createServer((socket) => {
    state.connections++;
    let last = Date.now();
    let buf = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      if (Date.now() - last > IDLE_MS) return socket.resetAndDestroy();
      buf += chunk.toString();
      if (!buf.includes("\r\n\r\n")) return;
      const close = /^connection:\s*close/im.test(buf);
      buf = "";
      socket.write(`HTTP/1.1 200 OK\r\ncontent-length: 2\r\n${close ? "connection: close\r\n" : ""}\r\nok`);
      last = Date.now();
      if (close) socket.end();
    });
  });
  return { server, state };
}

/** Two GETs on one context, the second after the server's idle timeout. */
async function getAfterIdle(ctx, url) {
  await (await ctx.get(url)).text();
  await new Promise((r) => setTimeout(r, IDLE_MS * 2));
  return (await ctx.get(url)).text();
}

describe("e2e API request context", () => {
  const { server, state } = staleSocketServer();
  let url = "";

  beforeAll(async () => {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${server.address().port}/`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it("the default pooled context fails on a stale socket (the harness reproduces the flake)", async () => {
    const ctx = await request.newContext();
    try {
      await expect(getAfterIdle(ctx, url)).rejects.toThrow(/ECONNRESET|socket hang up/);
    } finally {
      await ctx.dispose();
    }
  });

  it("the fixture's context survives a call after the server's idle timeout", async () => {
    const ctx = await newApiRequestContext(request);
    const before = state.connections;
    try {
      expect(await getAfterIdle(ctx, url)).toBe("ok");
      expect(state.connections - before, "each request opens its own connection").toBe(2);
    } finally {
      await ctx.dispose();
    }
  });

  it("keeps the caller's headers and options", async () => {
    let seen;
    const factory = { newContext: async (o) => (seen = o) };
    await newApiRequestContext(factory, { baseURL: "http://x", extraHTTPHeaders: { authorization: "Bearer t" } });
    expect(seen).toEqual({
      baseURL: "http://x",
      extraHTTPHeaders: { authorization: "Bearer t", ...apiRequestHeaders },
    });
  });
});
