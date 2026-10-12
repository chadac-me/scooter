/**
 * Tier 3 E2E for conversation history surviving a switch-away and back: send a message,
 * switch conversations, and confirm the first is restored from the session list with its
 * history intact. The full suspend/resume-with-workspace path is covered by the cluster tests.
 */

import { test, expect } from "./fixtures.js";

const sidebar = { item: '[data-testid="session-item"]' };

test.describe("conversation persistence (UI)", () => {
  // This test funds two full conversation boots on the full target.
  test.setTimeout(180_000);

  test("history is restored after switching away and back", async ({ chat, page }) => {
    await chat.open();
    await chat.send("remember this message");
    await chat.waitForReply(/dummy agent/i);

    // Start a new conversation, then return to the first; this turn funds the second
    // conversation's sandbox boot on the full target.
    await page.locator('[data-testid="new-session"]').click();
    await chat.send("a different conversation");
    await chat.waitForReply(/dummy agent/i, 100_000);

    // Return to the first conversation by its title, since .first() is the newest.
    await page.locator(sidebar.item).filter({ hasText: /remember this message/i }).first().click();
    await expect(chat.userMessages().filter({ hasText: /remember this message/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(chat.userMessages().filter({ hasText: /a different conversation/i })).toHaveCount(0);
  });
});
