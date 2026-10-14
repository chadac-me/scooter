/**
 * The /agui resume branch never leaves a silent open SSE: it keeps the stream open only
 * when `onResume` reports the resume was answered, emits RUN_ERROR and closes when it
 * could not be, and closes with RUN_ERROR if no frame arrives within a guard window.
 */

import { describe, it, expect } from "vitest";

import { createAguiServer } from "../../src/agui/server.js";

/** POST a resume to /agui and collect the raw SSE body until the socket closes or the deadline aborts it. */
async function postResume(
  onResume: (
    sessionId: string,
    entry: { interruptId: string; status: "resolved" | "cancelled"; payload?: unknown },
  ) => Promise<{ ok: boolean; reason?: string }>,
  opts: { deadlineMs?: number } = {},
): Promise<{ body: string; closed: boolean }> {
  const server = createAguiServer();
  server.onResume(onResume);
  await server.listen(0);
  const deadline = opts.deadlineMs ?? 4000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadline);
  let body = "";
  let closed = false;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port()}/agui`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "t1",
        resume: [{ interruptId: "req-1", status: "resolved", payload: { optionId: "approve" } }],
      }),
      signal: ctrl.signal,
    });
    body = await res.text();
    closed = true;
  } catch {
    // AbortError: the stream never closed within the deadline.
    closed = false;
  } finally {
    clearTimeout(timer);
    await server.close();
  }
  return { body, closed };
}

describe("/agui resume — never a silent open stream", () => {
  it("emits RUN_ERROR and CLOSES when the resume can't be answered (dormant run)", async () => {
    const { body, closed } = await postResume(async () => ({ ok: false, reason: "interrupt not found" }));
    expect(closed, "the resume stream must close, not hang").toBe(true);
    expect(body).toContain("RUN_ERROR");
  });

  it("does NOT force-close a resume that WAS answered (a real run streams its events)", async () => {
    // With the guard at its 60s default and a 1.5s deadline, the stream stays open and silent.
    const { body } = await postResume(async () => ({ ok: true }), { deadlineMs: 1500 });
    expect(body).not.toContain("RUN_ERROR");
  });

  it("guard closes an answered-but-frame-less resume with RUN_ERROR (defensive)", async () => {
    // Answered, but the run streams nothing.
    const prev = process.env.SCOOTER_RESUME_GUARD_MS;
    process.env.SCOOTER_RESUME_GUARD_MS = "300";
    try {
      const { body, closed } = await postResume(async () => ({ ok: true }), { deadlineMs: 4000 });
      expect(closed, "the guard must close the stream").toBe(true);
      expect(body).toContain("RUN_ERROR");
    } finally {
      if (prev === undefined) delete process.env.SCOOTER_RESUME_GUARD_MS;
      else process.env.SCOOTER_RESUME_GUARD_MS = prev;
    }
  });
});
