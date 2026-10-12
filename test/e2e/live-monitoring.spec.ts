/**
 * Tier 3 E2E for live conversation monitoring. Simulates a Slack-originated conversation
 * the way the webhooks service creates one (an out-of-band create + prompt for a
 * conversation this browser tab did not start), then asserts without any manual refresh
 * that the new conversation appears in the sidebar live (pushed via GET
 * /conversations/events, not the 10s poll) and that opening it shows the assistant's
 * reply streaming live from the integrity stream at full fidelity.
 */

import { test, expect } from "./fixtures.js";
import { isFull } from "./target.js";

const sel = {
  // A sidebar conversation row (Sidebar.tsx: data-testid="session-item").
  conversationRow: "[data-testid='session-item']",
};

/** Drive a conversation from outside the browser the way webhooks do: create it (awaited,
 *  so the caller's "appears live" budget starts once the row can exist), then prompt that
 *  id fire-and-forget. */
async function createExternalConversation(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  task: string,
): Promise<void> {
  const created = await request.post(`${base}/conversations`, {
    headers: { "Content-Type": "application/json" },
    data: { title: task },
    timeout: 30_000,
  });
  if (!created.ok()) return;
  const { id } = (await created.json()) as { id: string };
  void request
    .post(`${base}/agui`, {
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      data: { threadId: id, runId: "r1", messages: [{ id: "m1", role: "user", content: task }] },
      timeout: 60_000,
    })
    .catch(() => {
      /* fire-and-forget; the run drives server-side */
    });
}

test.describe("live monitoring", () => {
  // On the full target the remote run execs in a real sandbox and the row waits allow the
  // aggregated sidebar to settle.
  test.setTimeout(240_000);

  test(
    "a Slack-like conversation appears in the sidebar live (no refresh)",
    async ({ chat, page, request, baseURL }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await chat.open();

      await createExternalConversation(request, base, "help from slack");

      // The row shows up without reloading; on fast, 8s is strictly under the 10s merge poll
      // so the push itself is asserted, while on full the budget only has to beat fleet churn.
      await expect(
        page.locator(sel.conversationRow).filter({ hasText: /help from slack|slack/i }).first(),
      ).toBeVisible({ timeout: isFull ? 60_000 : 8_000 });
    },
  );

  test(
    "opening a remote-driven conversation streams its reply live (full fidelity)",
    async ({ chat, page, request, baseURL }) => {
      const base = (baseURL ?? "").replace(/\/$/, "");
      await chat.open();

      await createExternalConversation(request, base, "review the auth module");

      // Open the pushed conversation from the sidebar; this wait is not the push-latency
      // measurement, so it gets a plain cluster budget.
      const row = page.locator(sel.conversationRow).filter({ hasText: /auth module|slack/i }).first();
      await expect(row).toBeVisible({ timeout: isFull ? 60_000 : 8_000 });
      await row.click();

      // The assistant reply from a run this tab did not start renders live via the integrity
      // stream at full fidelity.
      await expect(chat.assistantMessages().last()).toContainText(/dummy agent/i, { timeout: 45_000 });
      await expect(chat.toolCalls().first()).toBeVisible({ timeout: 45_000 });
    },
  );

  test(
    "my own send routes fire-and-forget through /agui and renders via the stream",
    async ({ chat }) => {
      // With the single-source model, my own send is also rendered from the integrity stream.
      await chat.open();
      await chat.send("hello");
      await chat.waitForReply(/dummy agent/i);
    },
  );
});
