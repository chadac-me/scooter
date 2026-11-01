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

describe("agent-tools: web_fetch readability extraction", () => {
  const ARTICLE_HTML = `<!doctype html><html><head><title>Big Article</title></head><body>
    <nav><a href="/x">nav link</a></nav>
    <article>
      <h1>Big Article</h1>
      <p>${"This is a long paragraph of real article content. ".repeat(20)}</p>
      <p>Second paragraph with a <a href="https://example.com/ref">reference link</a> and more words to pad the
      length so readability treats this as the real content area rather than boilerplate.</p>
      <h2>A subheading</h2>
      <p>${"More article body text goes here to pad length further. ".repeat(10)}</p>
    </article>
    <footer>footer junk</footer>
  </body></html>`;

  it("converts a real article to Markdown, keeping headings and links, dropping nav/footer", async () => {
    const fetchImpl = (async () => new Response(ARTICLE_HTML)) as unknown as typeof fetch;
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/article" });
    const text = res.content[0].text;
    expect(res.isError).toBeUndefined();
    expect(text).toContain("# Big Article");
    expect(text).toContain("## A subheading");
    expect(text).toContain("[reference link](https://example.com/ref)");
    expect(text).not.toContain("nav link");
    expect(text).not.toContain("footer junk");
  });

  it("falls back to plain tag-stripping when readability finds no real article", async () => {
    const fetchImpl = (async () => new Response("<html><body><p>just a short snippet</p></body></html>")) as unknown as typeof fetch;
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/tiny" });
    expect(res.content[0].text).toBe("just a short snippet");
  });
});

describe("agent-tools: web_fetch paging (offset/max_chars, mirrors check_background)", () => {
  it("returns a short body whole, with no paging hint", async () => {
    const fetchImpl = (async () => new Response("hello there")) as unknown as typeof fetch;
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/" });
    expect(res.content[0].text).toBe("hello there");
  });

  it("caps a long body at max_chars and reports the total length + next offset", async () => {
    const body = Array.from({ length: 50_000 }, (_, i) => `w${i}`).join(" "); // plain text, not HTML
    const fetchImpl = (async () => new Response(body, { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/big", max_chars: 100 });
    const text = res.content[0].text;
    expect(text.startsWith(body.slice(0, 100))).toBe(true);
    expect(text).toMatch(/showing chars 0-100 of \d+/);
    expect(text).toMatch(/offset=100/);
  });

  it("pages from a given offset", async () => {
    const body = "0123456789".repeat(50); // 500 chars, plain text
    const fetchImpl = (async () => new Response(body, { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/big", offset: 200, max_chars: 10 });
    expect(res.content[0].text.startsWith(body.slice(200, 210))).toBe(true);
  });
});

describe("agent-tools: web_fetch PDF extraction", () => {
  // A minimal single-page PDF whose content stream shows the text "Hello PDF world".
  const MINIMAL_PDF = Buffer.from(
    `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj
4 0 obj<</Length 58>>
stream
BT /F1 24 Tf 20 100 Td (Hello PDF world) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
trailer<</Size 6/Root 1 0 R>>
%%EOF`,
    "utf8",
  );

  it("extracts text from an application/pdf response", async () => {
    const fetchImpl = (async () =>
      new Response(MINIMAL_PDF, { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/doc.pdf" });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("Hello PDF world");
  });

  it("sniffs a PDF by magic bytes even with no/odd content-type", async () => {
    const fetchImpl = (async () =>
      new Response(MINIMAL_PDF, { headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch;
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/doc.pdf" });
    expect(res.content[0].text).toContain("Hello PDF world");
  });
});

describe("agent-tools: web_fetch SSRF guard still applies with the new content paths", () => {
  it("refuses a PDF/HTML-looking URL the same as any other (the guard runs before fetch)", async () => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const res = await handleWebFetch({ fetchImpl }, { url: "http://169.254.169.254/latest/meta-data/x.pdf" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("refused");
  });

  it("refuses a redirect to an internal address before it would be processed as HTML/PDF", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      if (url === "http://203.0.113.10/") {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
      }
      throw new Error(`unexpected fetch of ${url}`);
    }) as unknown as typeof fetch;
    const res = await handleWebFetch({ fetchImpl }, { url: "http://203.0.113.10/" });
    expect(res.isError).toBe(true);
    expect(asked).toEqual(["http://203.0.113.10/"]);
  });
});
