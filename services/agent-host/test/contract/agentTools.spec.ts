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

describe("agent-tools: web_fetch follows redirects safely", () => {
  /** A fetch serving `routes` by URL, recording each request. */
  const serving = (routes: Record<string, () => Response>) => {
    const asked: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      asked.push({ url, redirect: init?.redirect });
      const route = routes[url];
      if (!route) throw new Error(`unexpected fetch of ${url}`);
      return route();
    }) as unknown as typeof fetch;
    return { fetchImpl, asked };
  };
  const to = (status: number, location: string) => () => new Response(null, { status, headers: { location } });

  it("FOLLOWS a 301 then a relative 308 to the page, and says where it landed", async () => {
    const { fetchImpl, asked } = serving({
      "http://203.0.113.10/old": to(301, "http://203.0.113.10/moved"),
      "http://203.0.113.10/moved": to(308, "/final"),
      "http://203.0.113.10/final": () => new Response("<p>the page</p>"),
    });
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/old" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("the page");
    expect(res.content[0].text).toContain("redirected to http://203.0.113.10/final");
    // Never delegated to fetch's own redirect handling, which skips the guard.
    expect(asked.every((a) => a.redirect === "manual")).toBe(true);
  });

  it("REFUSES a redirect to an internal address and never requests it", async () => {
    const { fetchImpl, asked } = serving({
      "http://203.0.113.10/": to(302, "http://169.254.169.254/latest/meta-data/"),
    });
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/refused.*169\.254\.169\.254/);
    expect(asked.map((a) => a.url)).toEqual(["http://203.0.113.10/"]);
  });

  it("gives up on a redirect loop", async () => {
    const { fetchImpl } = serving({
      "http://203.0.113.10/a": to(302, "/b"),
      "http://203.0.113.10/b": to(302, "/a"),
    });
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/a" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("more than 5 redirects");
  });

  it("names the underlying cause, not just \"fetch failed\"", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND nowhere") });
    }) as unknown as typeof fetch;
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/" });
    expect(res.content[0].text).toContain("ENOTFOUND");
  });
});
