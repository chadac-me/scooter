/**
 * Every POST /agui logs "agui request received" on entry and "agui stream closed" with
 * what the stream carried. A prompt that is accepted (200) but never runs, which is what
 * the e2e interrupt flakes look like, shows up as a received line followed by a close
 * with zero events, on whichever pod took it.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";

import { createAguiServer } from "../../src/agui/server.js";
import { reconfigureLogging } from "../../src/log.js";

let lines: Record<string, unknown>[] = [];
const realLog = console.log;

beforeEach(() => {
  lines = [];
  process.env.LOG_FORMAT = "json";
  reconfigureLogging();
  console.log = (...args: unknown[]) => {
    try {
      lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
    } catch {
      /* not one of ours */
    }
  };
});

afterEach(() => {
  console.log = realLog;
  delete process.env.LOG_FORMAT;
  reconfigureLogging();
});

const waitFor = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
};
const closed = () => lines.find((l) => l.msg === "agui stream closed");

const post = (port: number, body: object, signal?: AbortSignal) =>
  fetch(`http://127.0.0.1:${port}/agui`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

describe("POST /agui request/stream log lines", () => {
  it("a prompt that never streams closes with zero events, ended by the client", async () => {
    const server = createAguiServer();
    server.onPrompt(async () => {
      /* accepted, never runs */
    });
    await server.listen(0);
    const ctrl = new AbortController();
    try {
      void post(server.port(), { threadId: "conv-dropped", runId: "r1", messages: [{ role: "user", content: "x" }] }, ctrl.signal).catch(() => {});
      await waitFor(() => lines.some((l) => l.msg === "agui request received"));
      ctrl.abort();
      await waitFor(() => closed() !== undefined);
    } finally {
      await server.close();
    }

    const received = lines.find((l) => l.msg === "agui request received");
    expect(received).toMatchObject({ conversation_id: "conv-dropped", component: "agui", kind: "prompt", run_id: "r1" });
    expect(closed()).toMatchObject({ conversation_id: "conv-dropped", kind: "prompt", events: 0, last_event: null, ended_by_server: false });
  });

  it("a run that finishes reports its events and the terminal one", async () => {
    const server = createAguiServer();
    server.onPrompt(async (sessionId) => {
      server.broadcast(sessionId, { type: "RUN_STARTED", threadId: sessionId, runId: "r1" } as never);
      server.broadcast(sessionId, { type: "RUN_FINISHED", threadId: sessionId, runId: "r1" } as never);
    });
    await server.listen(0);
    try {
      const res = await post(server.port(), { threadId: "conv-ok", runId: "r1", messages: [{ role: "user", content: "x" }] });
      await res.text();
      await waitFor(() => closed() !== undefined);
    } finally {
      await server.close();
    }

    expect(closed()).toMatchObject({ conversation_id: "conv-ok", events: 2, last_event: "RUN_FINISHED", ended_by_server: true });
  });

  it("an answer to an interrupt is logged as a resume", async () => {
    const server = createAguiServer();
    server.onResume(async () => ({ ok: false, reason: "test" }));
    await server.listen(0);
    try {
      const res = await post(server.port(), {
        threadId: "conv-resume",
        resume: [{ interruptId: "i1", status: "resolved", payload: "Red" }],
      });
      await res.text();
      await waitFor(() => closed() !== undefined);
    } finally {
      await server.close();
    }

    expect(lines.find((l) => l.msg === "agui request received")).toMatchObject({ kind: "resume", resume_count: 1 });
    expect(closed()).toMatchObject({ kind: "resume", events: 1, last_event: "RUN_ERROR" });
  });
});
