/**
 * POST /agui and the legacy /sessions/:id/* routes refuse a caller who may not see a private
 * conversation, before any prompt is handed over or any stream opens.
 */

import { describe, it, expect, vi } from "vitest";

import { createAguiServer } from "../../src/agui/server.js";
import { createAccessCheck } from "../../src/session/access.js";

async function withServer(fn: (port: number, onPrompt: ReturnType<typeof vi.fn>) => Promise<void>, failCheck = false) {
  const server = createAguiServer();
  const onPrompt = vi.fn(async () => {});
  server.onPrompt(onPrompt);
  server.useIdentityResolver((req) => {
    const id = req.headers["x-auth-user"];
    return typeof id === "string" ? { id, anonymous: false } : { id: "anonymous", anonymous: true };
  });
  server.useAccessCheck(
    createAccessCheck({
      readAccess: failCheck
        ? async () => {
            throw new Error("db down");
          }
        : undefined,
      memory: (id) => (id === "priv" ? { owner: "alice", visibility: "private" } : undefined),
    }),
  );
  await server.listen(0);
  try {
    await fn(server.port()!, onPrompt);
  } finally {
    await server.close();
  }
}

const post = (port: number, threadId: string, user?: string) => {
  const ctrl = new AbortController();
  const p = fetch(`http://127.0.0.1:${port}/agui`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(user ? { "x-auth-user": user } : {}) },
    body: JSON.stringify({ threadId, messages: [{ role: "user", content: "hi" }] }),
    signal: ctrl.signal,
  });
  return { p, abort: () => ctrl.abort() };
};

describe("/agui on a private conversation", () => {
  it("refuses another user with 404 and never hands the prompt over", async () => {
    await withServer(async (port, onPrompt) => {
      const res = await post(port, "priv", "bob").p;
      expect(res.status).toBe(404);
      expect(onPrompt).not.toHaveBeenCalled();
    });
  });

  it("refuses an anonymous caller", async () => {
    await withServer(async (port, onPrompt) => {
      expect((await post(port, "priv").p).status).toBe(404);
      expect(onPrompt).not.toHaveBeenCalled();
    });
  });

  it("serves the owner", async () => {
    await withServer(async (port, onPrompt) => {
      const { p, abort } = post(port, "priv", "alice");
      p.catch(() => {}); // the SSE response flushes no headers until the first event
      for (let i = 0; i < 50 && onPrompt.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(onPrompt).toHaveBeenCalled();
      abort();
    });
  });

  it("lets a new thread through to the handler's own create-or-404 path", async () => {
    await withServer(async (port, onPrompt) => {
      const { p, abort } = post(port, "brand-new", "bob");
      p.catch(() => {});
      for (let i = 0; i < 50 && onPrompt.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(onPrompt).toHaveBeenCalled();
      abort();
    });
  });

  it("answers 503 when the visibility read fails", async () => {
    await withServer(async (port) => {
      expect((await post(port, "priv", "alice").p).status).toBe(503);
    }, true);
  });

  it("gates the legacy /sessions/:id/* routes too", async () => {
    await withServer(async (port, onPrompt) => {
      const res = await fetch(`http://127.0.0.1:${port}/sessions/priv/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-auth-user": "bob" },
        body: JSON.stringify({ threadId: "priv", messages: [] }),
      });
      expect(res.status).toBe(404);
      expect(onPrompt).not.toHaveBeenCalled();
    });
  });
});
