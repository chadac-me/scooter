/**
 * Tier 3 E2E for the commits contrib's proposal card. The broker raises it like any contrib
 * approval (POST /conversations/:id/approvals/commits, kind `commits.identity`), drawn by the
 * contrib's real ui/ProposalCard.tsx. When the user approves another agent's proposal the
 * broker withdraws this one (DELETE …/approvals/commits/:requestId), and the card must leave.
 */

import { type APIRequestContext, type Page } from "@playwright/test";
import { test, expect, shot } from "./fixtures.js";

const sel = {
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
  panel: '[data-testid="interrupt-panel"]',
  card: '[data-testid="commits-proposal-card"]',
  ident: '[data-testid="commits-proposed-ident"]',
  option: '[data-testid="interrupt-option"]',
};

async function serveRenderer(page: Page) {
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sources: {}, toolCards: {}, toolTitles: {}, linkProviders: [], approvals: { commits: {} }, settingsTabs: {},
        interruptRenderers: { "commits.identity": { contrib: "commits", entry: "commits/ui/ProposalCard.tsx" } },
      }),
    }),
  );
}

/** This test's conversation, from the UI's persisted selection. */
async function conversationId(page: Page): Promise<string> {
  let id = "";
  await expect(async () => {
    id = await page.evaluate(() => {
      const st = JSON.parse(localStorage.getItem("kubenix-agent.sessions.v1") ?? "{}") as {
        currentId?: string;
        sessions?: Array<{ id: string; serverId?: string }>;
      };
      return st.sessions?.find((s) => s.id === st.currentId)?.serverId ?? "";
    });
    expect(id).toBeTruthy();
  }).toPass({ timeout: 30_000 });
  return id;
}

/** Raise the card exactly as scooter_contrib_commits.host.card shapes it. */
function propose(request: APIRequestContext, base: string, conv: string, requestId: string) {
  return request.post(`${base}/conversations/${encodeURIComponent(conv)}/approvals/commits`, {
    headers: { "Content-Type": "application/json" },
    data: {
      request_id: requestId,
      message: "The agent proposes your commit identity: Ada Lovelace <ada@lovelace.dev>",
      kind: "commits.identity",
      data: { name: "Ada Lovelace", email: "ada@lovelace.dev" },
    },
  });
}

test.describe("commit identity proposal", () => {
  test.beforeEach(({ page }) => serveRenderer(page));

  test("the card shows the proposal and leaves when the broker withdraws it", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("set up the repo");
    await chat.waitForReply(/dummy agent/i);
    const conv = await conversationId(page);
    const requestId = `commits-${Date.now()}`;

    expect((await propose(request, base, conv, requestId)).status()).toBe(202);
    await expect(page.locator(sel.card)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(sel.approvalsTab)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(sel.ident)).toHaveText("Ada Lovelace <ada@lovelace.dev>");
    await expect(page.locator(sel.option).filter({ hasText: /approve/i })).toHaveCount(1);
    await expect(page.locator(sel.option).filter({ hasText: /deny/i })).toHaveCount(1);
    await shot(page, "commits proposal card");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(1_000);
    await shot(page, "commits proposal card dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: /^Details/ }).click();
    await expect(page.locator(sel.card)).toHaveCount(2);
    await shot(page, "commits proposal detail");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(1_000);
    await shot(page, "commits proposal detail dark");
    await page.emulateMedia({ colorScheme: "light" });

    // Another proposal won, so the broker withdraws this one.
    const res = await request.delete(`${base}/conversations/${encodeURIComponent(conv)}/approvals/commits/${requestId}`);
    expect(await res.json()).toEqual({ withdrawn: true });
    await expect(page.locator(sel.panel)).toHaveCount(0, { timeout: 15_000 });

    // After a reload the log still says it is settled.
    await page.reload();
    await chat.waitForReply(/dummy agent/i);
    await expect(page.locator(sel.card)).toHaveCount(0);
  });
});
