/**
 * Tier 3 E2E for a long conversation not wedging the app: with a long conversation loaded
 * or replaying, opening a new conversation and sending must work first try, and reloading
 * on a long conversation must paint it (tail seed) and still let you immediately switch to
 * a new conversation and send.
 */

import { test, expect } from "./fixtures.js";

const sidebar = { item: '[data-testid="session-item"]', newSession: '[data-testid="new-session"]' };

// Enough turns that the switch-back/reload goes through the /tail + full-replay path.
const LONG = ["m1-aaa", "m2-bbb", "m3-ccc", "m4-ddd", "m5-eee", "m6-fff", "m7-ggg", "m8-hhh"];

test.describe("long conversation doesn't block a new one", () => {
  // On the full target every turn is a real sandbox exec and each test funds two
  // conversation boots.
  test.setTimeout(240_000);

  test("start + send a NEW conversation immediately after a long one is loaded", async ({ chat, page }) => {
    await chat.open();
    for (const m of LONG) await chat.sendTurn(`turn ${m}`);
    await expect(chat.userMessages()).toHaveCount(LONG.length, { timeout: 45_000 });

    // With the long conversation live in the thread, start a new conversation and send;
    // this must succeed on the first attempt.
    await page.locator(sidebar.newSession).click();
    // This turn funds a second conversation boot, which under podCap=1 waits for a fresh pod
    // contended by the other specs on the shard.
    await chat.sendTurn("brand new conversation first-try", 150_000);

    // The new conversation shows exactly its own turn and reply, with no history bleeding in.
    await expect(chat.userMessages().filter({ hasText: /brand new conversation first-try/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(chat.userMessages()).toHaveCount(1);
    await expect(chat.userMessages().filter({ hasText: /turn m8-hhh/i })).toHaveCount(0);
  });

  test("reload ON a long conversation, then start a new one first-try", async ({ chat, page }) => {
    await chat.open();
    for (const m of LONG) await chat.sendTurn(`turn ${m}`);
    await expect(chat.userMessages()).toHaveCount(LONG.length, { timeout: 45_000 });

    // Reload with the long conversation open; the UI must stay interactive while the full
    // replay streams.
    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    // The tail seed should have painted the latest turn (fast first paint).
    await expect(chat.userMessages().filter({ hasText: /turn m8-hhh/i })).toHaveCount(1, { timeout: 30_000 });

    // Without waiting for the full replay to finish, open a new conversation and send.
    await page.locator(sidebar.newSession).click();
    // A second conversation boot under podCap=1, contended by the other specs sharing the shard.
    await chat.sendTurn("after-reload new conversation", 150_000);
    await expect(chat.userMessages().filter({ hasText: /after-reload new conversation/i })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(chat.userMessages()).toHaveCount(1);
  });
});
