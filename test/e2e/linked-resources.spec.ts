/**
 * Tier 3 E2E — the linked-resources panel.
 *
 * The webhooks service pushes a conversation's external resource links (the
 * GitHub PR / Slack thread it came from) to the agent-host; the UI shows them in
 * a collapsible left-panel tab. Here we push a link via the API (as a webhook
 * would) and assert the open UI surfaces it.
 */

import { test, expect } from "./fixtures.js";

const panel = {
  root: '[data-testid="linked-resources"]',
  toggle: '[data-testid="linked-resources-toggle"]',
  item: '[data-testid="linked-resource"]',
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

test.describe("linked resources panel", () => {
  test("a pushed link appears in the panel for the current conversation", async ({ chat, page, request, baseURL }) => {
    // On the full target the first reply is gated on a real sandbox boot, plus the panel's link poll.
    test.setTimeout(150_000);
    const base = baseURL ?? "http://localhost:5173";

    await chat.open();
    await chat.send("opening message");
    await chat.waitForReply(/dummy agent/i, 90_000);

    // The UI's current thread id.
    const threadId = await currentThreadId(page);

    // Push a link as the webhooks service would.
    const r = await request.post(`${base}/conversations/${threadId}/links`, {
      data: {
        source: "github",
        resourceType: "pull_request",
        url: "https://github.com/example-org/example-app/pull/203",
        title: "example-org/example-app #203",
      },
    });
    expect(r.ok()).toBeTruthy();

    // The panel refreshes on a 10s setInterval and each attempt round-trips the router on the
    // full target, so give it ~9 attempts.
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 90_000 });
    const item = page.locator(panel.item).filter({ hasText: /example-org\/example-app #203/i });
    await expect(item).toHaveCount(1, { timeout: 30_000 });
    // It links out to the PR.
    await expect(item.locator("a")).toHaveAttribute("href", /github\.com\/example-org\/example-app\/pull\/203/);
  });

  test("five or more links start collapsed; the toggle still opens them", async ({ chat, page, request, baseURL }) => {
    // A cold-provisioned first reply plus the panel's 10s link poll overruns the 60s default.
    test.setTimeout(150_000);
    const base = baseURL ?? "http://localhost:5173";

    await chat.open();
    await chat.send("opening message");
    await chat.waitForReply(/dummy agent/i, 90_000);

    const threadId = await currentThreadId(page);

    // Five links, the auto-collapse threshold (ui/src/LinkedResources.tsx).
    for (let i = 1; i <= 5; i++) {
      const r = await request.post(`${base}/conversations/${threadId}/links`, {
        data: {
          source: "github",
          resourceType: "pull_request",
          url: `https://github.com/example-org/example-app/pull/${300 + i}`,
          title: `example-org/example-app #${300 + i}`,
        },
      });
      expect(r.ok()).toBeTruthy();
    }

    // The panel appears collapsed: the count is visible, the rows are not.
    const toggle = page.locator(panel.toggle);
    await expect(toggle).toBeVisible({ timeout: 90_000 });
    await expect(toggle).toHaveText(/Linked \(5\)/, { timeout: 30_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(panel.item)).toHaveCount(0);

    // A click opens it, and the open state survives the next refresh poll (>10s).
    await toggle.click();
    await expect(page.locator(panel.item)).toHaveCount(5);
    await page.waitForTimeout(12_000);
    await expect(page.locator(panel.item)).toHaveCount(5);
  });

  test("the panel is hidden when a conversation has no links", async ({ chat, page }) => {
    // One cold-provisioned turn plus the absence assertion.
    test.setTimeout(150_000);
    await chat.open();
    await chat.send("no links here");
    await chat.waitForReply(/dummy agent/i, 90_000);
    await expect(page.locator(panel.root)).toHaveCount(0);
  });

  test("a conversation with a link shows a provider icon in the sidebar row", async ({ chat, page, request, baseURL }) => {
    // A cold-provisioned first reply plus the sidebar's merge poll.
    test.setTimeout(150_000);
    const base = baseURL ?? "http://localhost:5173";
    await chat.open();
    await chat.send("opening message");
    await chat.waitForReply(/dummy agent/i, 90_000);

    const threadId = await currentThreadId(page);

    // Target this conversation's row via data-active, since the sidebar sorts newest-first and
    // another spec's conversation can take the top slot.
    const row = page.locator('[data-testid="session-item"][data-active="true"]');
    await expect(row, "this conversation's own sidebar row (the ACTIVE one)").toHaveCount(1, { timeout: 20_000 });
    // No provider icon on the row before any link.
    await expect(row.locator('[data-testid="source-icon"]')).toHaveCount(0);

    // Push a GitHub link (as the webhooks service would).
    const r = await request.post(`${base}/conversations/${threadId}/links`, {
      data: { source: "github", resourceType: "pull_request", url: "https://github.com/example-org/example-app/pull/203" },
    });
    expect(r.ok()).toBeTruthy();

    // The sidebar row picks up the github badge via the /conversations merge poll, whose
    // every attempt round-trips the router on the full target.
    const icon = row.locator('[data-testid="source-icon"][data-source="github"]');
    await expect(icon).toHaveCount(1, { timeout: 90_000 });
  });
});
