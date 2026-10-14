/**
 * Tier 3 E2E against a live deployment: a real conversation spawns a real sandbox and runs
 * a real shell tool call via the in-cluster pods/exec path, which catches cluster-only
 * failures the fake stack cannot. Gated by RUN_EXTERNAL_E2E=1 and AGENT_HOST_URL=<base url
 * of the live agent-host>, with optional EXTERNAL_BASIC_AUTH=user:pass. It talks to the
 * agent-host's HTTP API directly (no browser), accumulating the assistant's reply from the
 * AG-UI stream and asserting on a sentinel the agent is told to echo.
 */

import { test, expect, request as pwRequest } from "@playwright/test";
import { fastOnly } from "./target.js";

const BASE = (process.env.AGENT_HOST_URL ?? "").replace(/\/$/, "");
const enabled = process.env.RUN_EXTERNAL_E2E === "1" && BASE !== "";
// Not on the full target, where the fake agent merely echoes the prompt and the sentinel
// assertions would pass vacuously; the env gate keeps it a cheap skip on fast unless
// RUN_EXTERNAL_E2E=1 opts in.
const maybe = enabled ? fastOnly("external mode — see the note above") : test.describe.skip;

function authHeader(): Record<string, string> {
  const ba = process.env.EXTERNAL_BASIC_AUTH;
  if (!ba) return {};
  return { Authorization: "Basic " + Buffer.from(ba).toString("base64") };
}

/** POST /agui with a task and accumulate the assistant's final text. */
async function runConversation(task: string, timeoutMs = 180_000): Promise<string> {
  const ctx = await pwRequest.newContext({ extraHTTPHeaders: authHeader() });
  try {
    // Create first, since the server assigns the id and refuses a caller-chosen threadId.
    const created = await ctx.post(`${BASE}/conversations`, {
      headers: { "Content-Type": "application/json" },
      data: { title: task.slice(0, 60) },
      timeout: 30_000,
    });
    expect(created.ok(), `POST /conversations failed: ${created.status()}`).toBeTruthy();
    const { id: threadId } = (await created.json()) as { id: string };
    const res = await ctx.post(`${BASE}/agui`, {
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      data: { threadId, runId: "r1", messages: [{ id: "m1", role: "user", content: task }] },
      timeout: timeoutMs,
    });
    expect(res.ok(), `POST /agui failed: ${res.status()}`).toBeTruthy();
    const body = await res.text();
    // Accumulate TEXT_MESSAGE_CONTENT deltas; surface RUN_ERROR.
    let text = "";
    let runError = "";
    for (const line of body.split("\n")) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m) continue;
      let ev: { type?: string; delta?: string; message?: string };
      try {
        ev = JSON.parse(m[1]);
      } catch {
        continue;
      }
      if (ev.type === "TEXT_MESSAGE_CONTENT" && ev.delta) text += ev.delta;
      if (ev.type === "RUN_ERROR") runError += (ev.message ?? "") + " ";
    }
    if (runError) text += `\n[RUN_ERROR] ${runError}`;
    return text;
  } finally {
    await ctx.dispose();
  }
}

maybe("external deployment", () => {
  test("the live API is reachable + auth works", async () => {
    const ctx = await pwRequest.newContext({ extraHTTPHeaders: authHeader() });
    const res = await ctx.get(`${BASE}/models`);
    await ctx.dispose();
    expect(res.ok(), `GET /models failed: ${res.status()}`).toBeTruthy();
  });

  test("a real shell tool call runs in the sandbox (in-cluster exec works)", async () => {
    // A working in-cluster pods/exec produces the sentinel; a broken one yields a RUN_ERROR
    // or no sentinel.
    const sentinel = `EXEC_OK_${Date.now()}`;
    const reply = await runConversation(
      `Run this shell command and report its output verbatim: echo ${sentinel}`,
    );
    expect(reply, `agent reply:\n${reply}`).toContain(sentinel);
    expect(reply).not.toMatch(/Permission denied|Unexpected server response|403|exec/i);
  });

  test("git clone over HTTPS works via the broker credential helper", async () => {
    // A tiny public repo so the clone is fast.
    const reply = await runConversation(
      "Clone the public repo https://github.com/githubtraining/hellogitworld " +
        "into /workspace/hello, then run `ls /workspace/hello` and report the output.",
      240_000,
    );
    expect(reply, `agent reply:\n${reply}`).toMatch(/README|LICENSE|\.git|hello/i);
    expect(reply).not.toMatch(/Permission denied|Unexpected server response|403|authentication failed/i);
  });
});
