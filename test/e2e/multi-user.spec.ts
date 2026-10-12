/**
 * e2e for true multi-user ownership: two browser contexts with different `x-auth-user`
 * headers (the ingress identity the real deployment injects), each seeing their own
 * conversations under "Mine". For a known user, "Mine" is strictly owner==me, so another
 * user's chats and unowned chats are hidden under Mine and shown under All; anonymous
 * still sees all, covered by ownership.spec.ts. Runs on both targets, with sidebar rows
 * located by `data-conversation-id` because titles do not survive the router create path.
 */

import { test, expect, seedConversation } from "./fixtures.js";
import type { Browser, Page } from "@playwright/test";

const sel = {
  filtersToggle: '[data-testid="filters-toggle"]',
  toggleMine: '[data-testid="scope-mine"]',
  toggleAll: '[data-testid="scope-all"]',
  userBadge: '[data-testid="user-badge"]',
};

/** The sidebar row for one conversation, by the server's id. */
const row = (page: Page, id: string) =>
  page.locator(`[data-testid="session-item"][data-conversation-id="${id}"]`);

/** A page in a context that carries `user` as the ingress identity header. */
async function pageAs(browser: Browser, user: string, email?: string): Promise<Page> {
  const context = await browser.newContext({
    extraHTTPHeaders: {
      "x-auth-user": user,
      ...(email ? { "x-auth-email": email } : {}),
    },
  });
  return context.newPage();
}

async function openFilters(page: Page) {
  const toggle = page.locator(sel.filtersToggle);
  await toggle.waitFor({ state: "visible", timeout: 20_000 });
  if ((await toggle.getAttribute("data-open")) !== "true") await toggle.click();
}

test.describe("multi-user ownership (Mine strictly distinguishes)", () => {
  test("alice sees only alice's chats under Mine; bob's + unowned are All-only", async ({
    browser,
    request,
    baseURL,
  }) => {
    // Three seeds, each bounded by seedConversation's 45s adoption ceiling, then the
    // sidebar assertions.
    test.setTimeout(240_000);
    const base = (baseURL ?? "http://localhost:5173").replace(/\/$/, "");

    // Seed three conversations: alice's, bob's, and an unowned one.
    const aliceId = await seedConversation(request, base, "alice", "Alice private plan");
    const bobId = await seedConversation(request, base, "bob", "Bob private plan");
    const unownedId = await seedConversation(request, base, null, "Legacy unowned chat");

    const alice = await pageAs(browser, "alice", "alice@x.io");
    try {
      await alice.goto("/");
      await openFilters(alice);

      // Mine (the default) for a known user is strictly her own.
      await expect(alice.locator(sel.toggleMine)).toHaveAttribute("data-active", "true");
      await expect(row(alice, aliceId)).toHaveCount(1, { timeout: 30_000 });
      await expect(row(alice, bobId)).toHaveCount(0);
      await expect(row(alice, unownedId)).toHaveCount(0);

      // All shows everything (hers, bob's, unowned).
      await alice.locator(sel.toggleAll).click();
      await expect(row(alice, bobId)).toHaveCount(1, { timeout: 30_000 });
      await expect(row(alice, unownedId)).toHaveCount(1);
      await expect(row(alice, aliceId)).toHaveCount(1);
    } finally {
      await alice.context().close();
    }
  });

  test("bob's Mine shows bob's, not alice's — symmetric isolation", async ({
    browser,
    request,
    baseURL,
  }) => {
    // Two seeds plus one sidebar assertion.
    test.setTimeout(180_000);
    const base = (baseURL ?? "http://localhost:5173").replace(/\/$/, "");
    const aliceId = await seedConversation(request, base, "alice", "Alice symmetric");
    const bobId = await seedConversation(request, base, "bob", "Bob symmetric");

    const bob = await pageAs(browser, "bob", "bob@x.io");
    try {
      await bob.goto("/");
      await openFilters(bob);

      await expect(row(bob, bobId)).toHaveCount(1, { timeout: 30_000 });
      await expect(row(bob, aliceId)).toHaveCount(0);
    } finally {
      await bob.context().close();
    }
  });

  test("the user badge shows the ingress identity (non-anonymous)", async ({ browser }) => {
    const alice = await pageAs(browser, "alice", "alice@x.io");
    try {
      await alice.goto("/");
      // With a real identity, the badge renders (email preferred).
      await expect(alice.locator(sel.userBadge)).toHaveCount(1, { timeout: 20_000 });
      await expect(alice.locator(sel.userBadge)).toContainText(/alice/i);
    } finally {
      await alice.context().close();
    }
  });
});
