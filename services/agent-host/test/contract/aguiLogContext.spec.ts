/**
 * A real POST /agui and the management router bind the conversation id into the log
 * context, so a log site deep inside a handler carries it without being handed one.
 * log.spec.ts covers the context mechanism itself; this covers the wiring.
 */

import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";

import { describe, it, expect } from "vitest";

import { createAguiServer } from "../../src/agui/server.js";
import { createRouter } from "../../src/http/router.js";
import { currentContext, logger, reconfigureLogging } from "../../src/log.js";

describe("POST /agui binds the log context", () => {
  it("makes the conversation id ambient inside the prompt handler", async () => {
    const server = createAguiServer();
    let seen: string | undefined;
    let seenAfterAwait: string | undefined;

    server.onPrompt(async () => {
      seen = currentContext().conversation_id;
      // The id must still be there after an await.
      await new Promise((r) => setTimeout(r, 5));
      seenAfterAwait = currentContext().conversation_id;
    });

    await server.listen(0);
    const ctrl = new AbortController();
    try {
      void fetch(`http://127.0.0.1:${server.port()}/agui`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "conv-from-the-wire",
          runId: "r1",
          messages: [{ id: "m1", role: "user", content: "hello" }],
        }),
        signal: ctrl.signal,
      }).catch(() => {});
      for (let i = 0; i < 100 && seenAfterAwait === undefined; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      ctrl.abort();
      await server.close();
    }

    expect(seen).toBe("conv-from-the-wire");
    expect(seenAfterAwait).toBe("conv-from-the-wire");
  });

  it("does not leak one request's conversation into the next", async () => {
    const server = createAguiServer();
    const seen: (string | undefined)[] = [];
    server.onPrompt(async () => {
      seen.push(currentContext().conversation_id);
    });
    await server.listen(0);

    const post = async (threadId: string) => {
      const ctrl = new AbortController();
      void fetch(`http://127.0.0.1:${server.port()}/agui`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, runId: "r1", messages: [{ id: "m", role: "user", content: "x" }] }),
        signal: ctrl.signal,
      }).catch(() => {});
      const want = seen.length + 1;
      for (let i = 0; i < 100 && seen.length < want; i++) await new Promise((r) => setTimeout(r, 10));
      ctrl.abort();
    };

    try {
      await post("conv-A");
      await post("conv-B");
    } finally {
      await server.close();
    }

    expect(seen).toEqual(["conv-A", "conv-B"]);
  });

  it("a line logged from inside the handler CARRIES the id", async () => {
    process.env.LOG_FORMAT = "json";
    reconfigureLogging();
    const lines: Record<string, unknown>[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      try {
        lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
      } catch {
        /* not one of ours */
      }
    };

    const server = createAguiServer();
    server.onPrompt(async () => {
      logger("bridge").info("prompt queued");
    });
    await server.listen(0);
    const ctrl = new AbortController();
    try {
      void fetch(`http://127.0.0.1:${server.port()}/agui`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "conv-logged",
          runId: "r1",
          messages: [{ id: "m", role: "user", content: "x" }],
        }),
        signal: ctrl.signal,
      }).catch(() => {});
      for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    } finally {
      ctrl.abort();
      await server.close();
      console.log = realLog;
      delete process.env.LOG_FORMAT;
      reconfigureLogging();
    }

    const queued = lines.find((l) => l.msg === "prompt queued");
    expect(queued).toBeDefined();
    expect(queued?.conversation_id).toBe("conv-logged");
    expect(queued?.component).toBe("bridge");
  });
});

describe("the management router binds the log context", () => {
  it("makes the path :id ambient for EVERY /conversations/:id route", async () => {
    // Binding at the dispatch point covers every route carrying a conversation id in its path.
    const router = createRouter();
    let seen: string | undefined;
    router.post("/conversations/:id/suspend", async () => {
      seen = currentContext().conversation_id;
      return { status: 200, json: { ok: true } };
    });

    const req = Object.assign(new PassThrough(), {
      method: "POST",
      url: "/conversations/conv-42/suspend",
      headers: {},
    });
    const res = {
      setHeader() {},
      writeHead() {
        return res;
      },
      end() {},
      write() {},
      req,
    } as unknown as ServerResponse;

    await router.handle(req as never, res);
    expect(seen).toBe("conv-42");
  });

  it("binds nothing for a route with no conversation id", async () => {
    const router = createRouter();
    let seen: string | undefined = "sentinel";
    router.get("/healthz", async () => {
      seen = currentContext().conversation_id;
      return { status: 200, json: {} };
    });
    const req = Object.assign(new PassThrough(), { method: "GET", url: "/healthz", headers: {} });
    const res = {
      setHeader() {},
      writeHead() {
        return res;
      },
      end() {},
      write() {},
      req,
    } as unknown as ServerResponse;

    await router.handle(req as never, res);
    expect(seen).toBeUndefined();
  });
});
