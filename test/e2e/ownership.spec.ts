/**
 * e2e for conversation ownership and the Mine/All sidebar filter. The browser UI is
 * anonymous on both targets, so it sees everything under "Mine"; a conversation owned by
 * another user is seeded via the API (passing x-auth-user, as the ingress would) and the
 * toggle is exercised. The owner-filtering logic itself is covered by the contract tests,
 * and the two-identity story by multi-user.spec.ts; rows are located by
 * `data-conversation-id` because titles do not survive the router create path.
 */

import { test, expect, seedConversation } from "./fixtures.js";

const sidebar = {
  // Mine/All lives inside the collapsible "Advanced" filters panel.
  filtersToggle: '[data-testid="filters-toggle"]',
  toggleMine: '[data-testid="scope-mine"]',
  toggleAll: '[data-testid="scope-all"]',
};

/** Open the "Advanced" filters panel (which holds the Mine/All scope toggle). */
async function openFilters(page: import("@playwright/test").Page) {
  const toggle = page.locator(sidebar.filtersToggle);
  if ((await toggle.getAttribute("data-open")) !== "true") await toggle.click();
}

test.describe("conversation ownership + Mine/All filter", () => {
  test("the sidebar has a Mine/All toggle defaulting to Mine", async ({ chat, page }) => {
    await chat.open();
    await openFilters(page);
    await expect(page.locator(sidebar.toggleMine)).toBeVisible();
    await expect(page.locator(sidebar.toggleAll)).toBeVisible();
    await expect(page.locator(sidebar.toggleMine)).toHaveAttribute("data-active", "true");
  });

  test("the header user badge is HIDDEN when anonymous (no identity header)", async ({ chat, page }) => {
    // The e2e stack sends no x-auth-user, so /whoami is anonymous and the badge must render nothing.
    await chat.open();
    await expect(page.locator('[data-testid="user-badge"]')).toHaveCount(0);
  });

  test("a conversation owned by another user is visible to the anonymous UI under Mine and All", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    // One seed bounded by seedConversation's 45s adoption ceiling plus a sidebar assertion.
    test.setTimeout(120_000);
    const base = (baseURL ?? "http://localhost:5173").replace(/\/$/, "");
    // Seed a conversation owned by bob.
    const id = await seedConversation(request, base, "bob", "Bob's private work");

    await chat.open();
    await openFilters(page);

    const bobRow = page.locator(`[data-testid="session-item"][data-conversation-id="${id}"]`);

    // The UI's caller is anonymous, so Mine shows everything and Bob's appears under both scopes.
    await page.locator(sidebar.toggleAll).click();
    await expect(bobRow).toHaveCount(1, { timeout: 30_000 });

    // Toggle back to Mine: still present, and the toggle state flips.
    await page.locator(sidebar.toggleMine).click();
    await expect(page.locator(sidebar.toggleMine)).toHaveAttribute("data-active", "true");
    await expect(bobRow).toHaveCount(1);
  });
});
