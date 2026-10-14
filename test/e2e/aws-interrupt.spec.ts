/**
 * Tier 3 E2E for the AWS approval interrupt. When the agent requests AWS access the broker
 * POSTs /conversations/:id/approvals/:contrib, which raises a bare RUN_FINISHED interrupt
 * that is not tied to a goose run and can arrive while a run is in flight; it must surface
 * as the InterruptPanel. The tests drive the real broker→host route directly, exercising
 * route → raiseInterrupt → persist → integrity stream → UI.
 */

import { test, expect } from "./fixtures.js";
import { isFull } from "./target.js";

const panel = {
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  message: '[data-testid="interrupt-message"]',
};

/** The server id of the conversation this test is looking at, polled from the UI's own
 *  selection and confirmed against the server's list. */
async function firstConversationId(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  page: import("@playwright/test").Page,
): Promise<string> {
  // This test's conversation from the UI's persisted selection, not list[0], which on a
  // shared fleet is whatever any spec created last; `serverId` is the server's id and
  // `currentId` a local key.
  let id = "";
  for (let i = 0; i < 30 && !id; i++) {
    id =
      (await page.evaluate(() => {
        try {
          const raw = localStorage.getItem("kubenix-agent.sessions.v1");
          if (!raw) return "";
          const st = JSON.parse(raw) as {
            currentId?: string;
            sessions?: Array<{ id: string; serverId?: string }>;
          };
          return st.sessions?.find((s) => s.id === st.currentId)?.serverId ?? "";
        } catch {
          return "";
        }
      })) ?? "";
    if (!id) await page.waitForTimeout(1000);
  }
  expect(id, "the conversation this test created must have a server id").toBeTruthy();

  // Confirm the server lists it before acting on it; the router's aggregate can be
  // transiently partial, so this is a retry.
  for (let i = 0; i < 30; i++) {
    const res = await request.get(`${base}/conversations`);
    if (res.ok()) {
      const rows = (await res.json()) as Array<{ id: string }>;
      if (rows.some((r) => r.id === id)) return id;
    }
    await page.waitForTimeout(1000);
  }
  expect(false, `the conversation ${id} never appeared in the server's list`).toBeTruthy();
  return id;
}

/** POST the approval exactly like a contrib's broker half does (aws _notify_host), retrying
 *  a 404 on the full target because the router's ownership cache can lag a fresh conversation. */
async function requestAws(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  conversationId: string,
  requestId: string,
) {
  const post = () =>
    request.post(`${base}/conversations/${encodeURIComponent(conversationId)}/approvals/aws`, {
      headers: { "Content-Type": "application/json" },
      timeout: 120_000, // the route may revive the sandbox before its 202
      // The generic payload: an id plus the prose the contrib rendered.
      data: {
        request_id: requestId,
        message:
          "Scooter is requesting AWS access to dev (risk: low).\n" +
          "s3:GetObject on the state bucket\n" +
          "Reason: read terraform state",
      },
    });

  let res = await post();
  if (!isFull) return res;
  for (let i = 0; i < 10 && res.status() === 404; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    res = await post();
  }
  return res;
}

/** Timeout for the API POSTs that await real sandbox work on the full target before
 *  replying, past Playwright's 30s APIRequest default. */
const API_BUDGET_MS = 120_000;

test.describe("AWS approval interrupt", () => {
  // Each test funds a sandbox provision plus, for the suspend tests, a real suspend and resume.
  test.beforeEach(() => test.setTimeout(240_000));

  test("the approval panel appears when the broker requests AWS access", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();

    // A live conversation with an active bridge (a normal send builds it).
    await chat.send("start working on the terraform plan");
    await chat.waitForReply(/dummy agent/i);

    // The conversation id (== threadId).
    const conversationId: string = await firstConversationId(request, base, page);
    expect(conversationId).toBeTruthy();

    // The broker notifies the agent-host that the agent requested AWS access.
    const res = await requestAws(request, base, conversationId, `awsreq-${Date.now()}`);
    expect(res.status(), "the approvals route must accept it (not 404 — no active bridge)").toBe(202);

    // The approval panel must appear, with Approve + Deny, describing the request.
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.option).filter({ hasText: /approve/i })).toHaveCount(1);
    await expect(page.locator(panel.option).filter({ hasText: /deny/i })).toHaveCount(1);
    await expect(page.locator(panel.message)).toContainText(/AWS access to dev/i);
  });

  test("the panel appears even when the conversation's bridge is inactive (suspended)", async ({ chat, page, baseURL, request }) => {
    // The agent hit AWS after the conversation went idle, so the route must revive the
    // conversation and raise the interrupt.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("long-running terraform work");
    await chat.waitForReply(/dummy agent/i);

    const conversationId: string = await firstConversationId(request, base, page);

    // Suspend it (drops the in-memory bridge).
    const susp = await request.post(`${base}/conversations/${encodeURIComponent(conversationId)}/suspend`, {
      timeout: API_BUDGET_MS, // awaits the real sandbox suspend on the full target
    });
    expect(susp.ok()).toBeTruthy();

    // The route must revive and raise, not 404.
    const res = await requestAws(request, base, conversationId, `awsreq-susp-${Date.now()}`);
    expect(res.status(), "the approvals route must revive an inactive conversation, not 404").toBe(202);

    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.option).filter({ hasText: /approve/i })).toHaveCount(1);
  });

  test("ANSWERING via /agui resume returns (does not hang) after the bridge was dropped", async ({ chat, page, baseURL, request }) => {
    // After a rollout or idle-suspend the paused run is gone from memory; the resume POST
    // must revive and answer (or close with a RUN_ERROR), never leave a 0-byte stream open.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("terraform apply needing AWS");
    await chat.waitForReply(/dummy agent/i);

    const conversationId: string = await firstConversationId(request, base, page);

    // Raise the AWS interrupt, then suspend to drop the in-memory bridge.
    const reqId = `awsreq-resume-${Date.now()}`;
    expect((await requestAws(request, base, conversationId, reqId)).status()).toBe(202);
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    expect(
      (
        await request.post(`${base}/conversations/${encodeURIComponent(conversationId)}/suspend`, {
          timeout: API_BUDGET_MS, // awaits the real sandbox suspend on the full target
        })
      ).ok(),
    ).toBeTruthy();

    // Answer like InterruptPanel.tsx does and assert on elapsed time: a hang resolves only
    // at the request timeout, and the bounds are per-target because the full target's
    // revive is a real sandbox resume.
    const hangTimeoutMs = isFull ? 150_000 : 20_000;
    const promptReturnMs = isFull ? 120_000 : 8_000;
    const started = Date.now();
    const resume = await request.post(`${base}/agui`, {
      headers: { "Content-Type": "application/json" },
      timeout: hangTimeoutMs, // a hang resolves only here
      data: {
        threadId: conversationId,
        resume: [{ interruptId: reqId, status: "resolved", payload: { optionId: "approve" } }],
      },
    });
    const elapsed = Date.now() - started;
    expect(resume.ok(), "the resume POST must return, not hang").toBeTruthy();
    const body = await resume.text();
    // Well-formed SSE that carried a frame, not 0 bytes.
    expect(body.length, "the resume stream must carry frames, not 0 bytes").toBeGreaterThan(0);
    // The decisive assertion: it returned promptly at its target's pace.
    expect(elapsed, `resume took ${elapsed}ms — a hang would take ~${hangTimeoutMs}ms`).toBeLessThan(promptReturnMs);
  });

  test("the AWS approval panel is still present after a page reload", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("another terraform task");
    await chat.waitForReply(/dummy agent/i);

    const conversationId: string = await firstConversationId(request, base, page);
    await requestAws(request, base, conversationId, `awsreq-reload-${Date.now()}`);
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });

    // The interrupt is persisted, so it must survive a reload.
    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.option).filter({ hasText: /approve/i })).toHaveCount(1);
  });
});
