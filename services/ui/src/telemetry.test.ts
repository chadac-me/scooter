/**
 * Telemetry must be inert and safe when it is off, which is the default everywhere.
 *
 * No call in this module may throw into its caller, and none may do anything
 * observable before a collector is configured.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  record,
  startSpan,
  recordError,
  initTelemetryFromServer,
  ATTR,
  classifyRoute,
  tracedRequestUrl,
} from "./telemetry.js";
import type { Span } from "@opentelemetry/api";

/** A span stand-in carrying only the attributes the instrumentation has already set. */
const spanWith = (attributes: Record<string, unknown>) => ({ attributes }) as unknown as Span;

describe("telemetry is inert when disabled", () => {
  it("record() does nothing and does not throw", () => {
    expect(() => record("some.event", { a: "b" })).not.toThrow();
  });

  it("startSpan() returns undefined rather than a fake span", () => {
    // Callers use `?.end()`; handing back a stub would hide a misconfiguration.
    expect(startSpan("some.span")).toBeUndefined();
  });

  it("recordError() swallows anything, including non-Errors", () => {
    expect(() => recordError("boom", new Error("real"))).not.toThrow();
    expect(() => recordError("boom", "a string")).not.toThrow();
    expect(() => recordError("boom", undefined)).not.toThrow();
    expect(() => recordError("boom", { weird: true })).not.toThrow();
  });
});

describe("initTelemetryFromServer", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("stays OFF when the config endpoint 404s (no collector deployed)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 404 })) as never;
    await expect(initTelemetryFromServer()).resolves.toBeUndefined();
    expect(startSpan("x")).toBeUndefined();
  });

  it("stays OFF when the config says enabled:false", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ enabled: false }), { status: 200 }),
    ) as never;
    await initTelemetryFromServer();
    expect(startSpan("x")).toBeUndefined();
  });

  it("does not throw when the config is malformed", async () => {
    globalThis.fetch = vi.fn(async () => new Response("not json", { status: 200 })) as never;
    await expect(initTelemetryFromServer()).resolves.toBeUndefined();
  });

  it("does not throw when the fetch itself rejects (offline / blocked)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as never;
    await expect(initTelemetryFromServer()).resolves.toBeUndefined();
  });
});

describe("attribute names are stable", () => {
  it("keeps BOTH conversation identifiers", () => {
    // A conversation has a local key before the server assigns its id, so a trace needs both.
    expect(ATTR.conversationKey).toBe("scooter.conversation.key");
    expect(ATTR.conversationId).toBe("scooter.conversation.id");
  });
});

describe("tracedRequestUrl", () => {
  // Every fetch in this UI is fetch(url, init), and the instrumentation passes `init` here.
  const init = { headers: { Accept: "text/event-stream" }, signal: {} };

  it("falls back to the span's URL when handed a RequestInit", () => {
    const span = spanWith({ "url.full": "https://host/conversations/abc/web-services" });
    expect(tracedRequestUrl(init, span)).toBe("https://host/conversations/abc/web-services");
  });

  it("never stringifies an object into the URL", () => {
    // "[object Object]" classified every span as "other" and hid the UI's whole request mix.
    expect(tracedRequestUrl(init, spanWith({}))).not.toContain("object Object");
  });

  it("accepts the older semconv attribute name too", () => {
    expect(tracedRequestUrl(init, spanWith({ "http.url": "https://host/models" }))).toBe(
      "https://host/models",
    );
  });

  it("prefers the request's own url when it really is a Request", () => {
    const span = spanWith({ "url.full": "https://host/other" });
    expect(tracedRequestUrl({ url: "https://host/conversations/abc/ready" }, span)).toBe(
      "https://host/conversations/abc/ready",
    );
  });

  it("takes a plain string URL as-is", () => {
    expect(tracedRequestUrl("https://host/models", spanWith({}))).toBe("https://host/models");
  });

  it("yields empty rather than throwing on junk", () => {
    expect(tracedRequestUrl(undefined, spanWith({}))).toBe("");
    expect(tracedRequestUrl(null, spanWith({}))).toBe("");
    expect(tracedRequestUrl(init, {} as unknown as Span)).toBe("");
  });
});

describe("classifyRoute", () => {
  it("separates the high-volume polled routes from each other", () => {
    // These were a single "other" bucket, which is why their cost was invisible.
    expect(classifyRoute("https://host/conversations/abc/ready")).toBe("ready");
    expect(classifyRoute("https://host/conversations/abc/web-services")).toBe("web-services");
    expect(classifyRoute("https://host/conversations/abc/links")).toBe("links");
  });

  it("buckets every contrib relay call together, whatever its path ends in", () => {
    expect(classifyRoute("https://host/conversations/abc/contrib-api/shares/list")).toBe("contrib-api");
    expect(classifyRoute("https://host/contrib-api/echo/links")).toBe("contrib-api");
  });

  it("distinguishes the two SSE streams, which have very different lifetimes", () => {
    expect(classifyRoute("https://host/conversations/abc/events.integrity")).toBe("stream");
    expect(classifyRoute("https://host/conversations/events?scope=all")).toBe("list-stream");
  });

  it("keeps the query string out of the bucket", () => {
    expect(classifyRoute("https://host/conversations?scope=all")).toBe("list-or-create");
    expect(classifyRoute("https://host/conversations/abc/tail?limit=300")).toBe("tail");
  });

  it("groups a service's start/stop with its listing", () => {
    expect(classifyRoute("https://host/conversations/abc/web-services/marimo/start")).toBe(
      "web-services",
    );
    expect(classifyRoute("https://host/conversations/abc/web-services/marimo/stop")).toBe(
      "web-services",
    );
  });

  it("reports an unreadable URL as unknown, never as other", () => {
    // "other" means "a route we chose not to name"; "unknown" means the instrumentation broke.
    expect(classifyRoute("")).toBe("unknown");
    expect(classifyRoute("https://host/something-new")).toBe("other");
  });

  it("works on a path-only URL, since same-origin fetches pass one", () => {
    expect(classifyRoute("/conversations/abc/ready")).toBe("ready");
    expect(classifyRoute("/models")).toBe("models");
  });
});
