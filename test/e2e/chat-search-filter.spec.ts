/**
 * Tier 3 E2E for sidebar chat search, the provider filter, and the Titles/Links label mode.
 * Two conversations are created, one linked to a GitHub PR via the links API (as a webhook
 * would) and one plain, and the test exercises keyword search over title and link name, the
 * provider filter chips, and the Titles/Links toggle.
 */

import { test, expect, fillStable } from "./fixtures.js";
import { isFull } from "./target.js";

const sb = {
  item: '[data-testid="session-item"]',
  title: '[data-testid="session-title"]',
  search: '[data-testid="session-search"]',
  filtersToggle: '[data-testid="filters-toggle"]',
  providerGithub: '[data-testid="provider-github"]',
  labelTitle: '[data-testid="label-title"]',
  labelGithub: '[data-testid="label-github"]',
  labelSlack: '[data-testid="label-slack"]',
  empty: '[data-testid="session-empty"]',
  scopeAll: '[data-testid="scope-all"]',
};

async function currentThreadId(page: import("@playwright/test").Page): Promise<string> {
  // Poll for serverId, which is persisted asynchronously after the server creates the
  // conversation and on the full target round-trips the router.
  let id = "";
  for (let i = 0; i < 150; i++) {
    id = await page.evaluate(() => {
      const raw = window.localStorage.getItem("kubenix-agent.sessions.v1");
      // The server's id, not `currentId`, which is a local key the server never issued.
      if (!raw) return "";
      const st = JSON.parse(raw) as {
        currentId?: string;
        sessions?: Array<{ id: string; serverId?: string }>;
      };
      return st.sessions?.find((s) => s.id === st.currentId)?.serverId ?? "";
    });
    if (id) break;
    await page.waitForTimeout(100);
  }
  expect(id).toBeTruthy();
  return id;
}

test.describe("sidebar search + filter + label mode", () => {
  test("search, provider chips, and the Titles/Links toggle", async ({ chat, page, request, baseURL }) => {
    // This test creates two conversations, and on the full target each first reply is gated
    // on a real sandbox boot, with two 90s row waits on top.
    test.setTimeout(360_000);
    const base = baseURL ?? "http://localhost:5173";
    // A per-run nonce on the GitHub link name keeps the link-name assertions naming exactly
    // this run's conversation on the shared fleet; the rows themselves are pinned by server id.
    const nonce = `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

    // Conversation A will be linked to a GitHub PR; the 90s reply budget covers a cold sandbox provision.
    await chat.open();
    await chat.send(`investigate the flaky broker test ${nonce}`);
    await chat.waitForReply(/dummy agent/i, 90_000);
    const threadA = await currentThreadId(page);
    const linkBody = {
      source: "github",
      resourceType: "pull_request",
      url: "https://github.com/example-org/example-app/pull/203",
      // The label-mode assertions count rows showing this link name, so the nonce keeps the
      // count exact on the shared fleet.
      title: `example-org/example-app #203 ${nonce}`,
    };
    // Retry the link POST (idempotent setup, not the behaviour under test) and report the
    // status when it never takes.
    let r = await request.post(`${base}/conversations/${threadA}/links`, { data: linkBody });
    for (let i = 0; i < 4 && !r.ok(); i++) {
      await page.waitForTimeout(2_000);
      r = await request.post(`${base}/conversations/${threadA}/links`, { data: linkBody });
    }
    // Read the body only on failure, since `expect(cond, msg)` builds its message eagerly and
    // would consume the response on the success path.
    if (!r.ok()) {
      const why = await r.text().catch(() => "");
      expect(r.ok(), `linking conversation A failed: ${r.status()} ${why}`).toBeTruthy();
    }

    // Conversation B: plain, no links, with its own sandbox under podCap=1.
    await page.locator('[data-testid="new-session"]').click();
    await chat.send(`just some scratch notes ${nonce}`);
    await chat.waitForReply(/dummy agent/i, 90_000);
    const threadB = await currentThreadId(page);

    // Rows are pinned by server id: the fleet's aggregated list can transiently resurface
    // other specs' rows, and a row's derived title can be overridden by the agent.
    const rowA = page.locator(`${sb.item}[data-conversation-id="${threadA}"]`);
    const rowB = page.locator(`${sb.item}[data-conversation-id="${threadB}"]`);

    // Open the advanced-filters panel (Scope / Linked / Show live inside it).
    await page.locator(sb.filtersToggle).click();
    // Show all conversations (both rows regardless of owner).
    await page.locator(sb.scopeAll).click();
    // Poll for both rows: the router's aggregated list degrades to a partial one while pods
    // churn, so a row that exists can be absent from one refresh.
    await expect(rowA).toHaveCount(1, { timeout: 90_000 });
    await expect(rowB).toHaveCount(1, { timeout: 90_000 });
    // On the deterministic fast stack the two rows are also the only rows.
    if (!isFull) await expect(page.locator(sb.item)).toHaveCount(2);

    // (1) Keyword search matches the link name, which is not in either title; the match
    // depends on the sidebar's separate link-merge poll, and fillStable guards against the
    // autoFocus composer swallowing the query.
    await fillStable(page.locator(sb.search), "#203");
    await expect(rowA, "the link name must be searchable once the merge lands").toHaveCount(1, {
      timeout: 90_000,
    });
    await expect(rowB).toHaveCount(0, { timeout: 90_000 });
    if (!isFull) await expect(page.locator(sb.item)).toHaveCount(1);

    // Search matches a plain title too, with the same partial-list budget as above.
    await fillStable(page.locator(sb.search), "scratch");
    await expect(rowB).toHaveCount(1, { timeout: 30_000 });
    await expect(rowA).toHaveCount(0, { timeout: 30_000 });
    // A non-matching query yields the empty state, but wait for this test's rows to be
    // filtered out first since `session-empty` only renders with zero rows.
    await fillStable(page.locator(sb.search), "zzz-nomatch");
    await expect(rowA).toHaveCount(0, { timeout: 30_000 });
    await expect(rowB).toHaveCount(0, { timeout: 30_000 });
    // The empty state is fast-only: on the full target another spec's conversation
    // legitimately keeps the count above zero.
    if (!isFull) await expect(page.locator(sb.empty)).toBeVisible({ timeout: 30_000 });
    await fillStable(page.locator(sb.search), "");

    // (2) Provider filter chips: GitHub keeps the linked conversation and drops the unlinked
    // one, once both rows are back from the cleared search.
    await expect(rowA, "the rows must return after the search is cleared").toHaveCount(1, { timeout: 60_000 });
    await expect(rowB, "the rows must return after the search is cleared").toHaveCount(1, { timeout: 60_000 });

    await page.locator(sb.providerGithub).click();
    await expect(rowA).toHaveCount(1, { timeout: 30_000 });
    await expect(rowB).toHaveCount(0, { timeout: 30_000 });
    if (!isFull) await expect(page.locator(sb.item)).toHaveCount(1);
    await page.locator(sb.providerGithub).click(); // toggle off
    await expect(rowB).toHaveCount(1, { timeout: 30_000 });
    await expect(rowA).toHaveCount(1, { timeout: 30_000 });
    if (!isFull) await expect(page.locator(sb.item)).toHaveCount(2);

    // (3) "Show" segmented control -> GitHub: the linked row shows the PR name and the
    // unlinked row falls back to its title, asserted on the pinned rows' own title elements.
    await page.locator(sb.labelGithub).click();
    await expect(rowA.locator(sb.title)).toHaveText(
      new RegExp(`example-org/example-app #203 ${nonce}`, "i"),
      { timeout: 30_000 },
    );
    // The unlinked row has no GitHub name to show, so it falls back to its own title.
    await expect(rowB.locator(sb.title)).not.toHaveText(
      new RegExp(`example-org/example-app #203 ${nonce}`, "i"),
    );
    // Under a provider the linked row doesn't have (Slack), it falls back to its title.
    await page.locator(sb.labelSlack).click();
    await expect(rowA.locator(sb.title)).not.toHaveText(
      new RegExp(`example-org/example-app #203 ${nonce}`, "i"),
      { timeout: 30_000 },
    );
    // Back to the Scooter/title mode: the linked row shows its conversation title again.
    await page.locator(sb.labelTitle).click();
    await expect(rowA.locator(sb.title)).not.toHaveText(
      new RegExp(`example-org/example-app #203 ${nonce}`, "i"),
      { timeout: 30_000 },
    );
  });
});
