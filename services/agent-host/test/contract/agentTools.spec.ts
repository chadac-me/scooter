/**
 * `web_fetch` and its SSRF guard, the one agent tool the agent-host serves itself
 * because it needs no credential. Credentialed tools live in the contrib that owns
 * the credential, with their tests.
 */

import { describe, it, expect } from "vitest";

import { handleWebFetch, registerWebFetch } from "../../src/agent/agentTools.js";

describe("agent-tools: web_fetch SSRF guard", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:8080/",
    "http://10.0.0.5/",
    "http://agent-broker.agent-sandbox.svc.cluster.local/",
  ])("refuses %s", async (url) => {
    const out = await handleWebFetch({}, { url });
    expect(out.isError).toBe(true);
  });
});

describe("agent-tools: web_fetch needs no credential and no broker", () => {
  it("registers with no deps at all", () => {
    const names = new Set<string>();
    const server = { registerTool: (name: string) => names.add(name) } as unknown as Parameters<
      typeof registerWebFetch
    >[0];
    registerWebFetch(server, {});
    expect(names.has("web_fetch")).toBe(true);
  });

  it("registers web_fetch ALONE — web_search belongs to a search contrib now", () => {
    // Search arrives over the broker's /mcp as one tool per enabled search contrib.
    const names = new Set<string>();
    const server = { registerTool: (name: string) => names.add(name) } as unknown as Parameters<
      typeof registerWebFetch
    >[0];
    registerWebFetch(server, {});
    expect([...names]).toEqual(["web_fetch"]);
  });

  it("reports a reachability failure rather than throwing", async () => {
    // A TEST-NET-3 IP literal skips DNS in the guard, so the fetch path runs without a resolver.
    const out = await handleWebFetch({
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    }, { url: "http://203.0.113.10/page" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("offline");
  });
});
