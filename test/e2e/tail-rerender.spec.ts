/**
 * Tier 3 E2E for a multi-turn conversation re-rendering on switch-back: the tail seed and
 * the full integrity replay must converge on the populated thread, never an empty one.
 * Drives several turns, swaps to another conversation, swaps back, and asserts the history
 * is present and the latest turn is visible.
 */

import { test, expect } from "./fixtures.js";

const sidebar = { item: '[data-testid="session-item"]', newSession: '[data-testid="new-session"]' };

test.describe("multi-turn re-render (tail + replay)", () => {
  // On the full target every turn is a real sandbox exec and the switch-away tests fund a
  // second conversation boot.
  test.setTimeout(240_000);

  /** Per-turn budget, applied to every turn because each exec waits for a ready pod and a
   *  warm pod is not guaranteed. */
  const TURN_MS = 90_000;

  test("a longer conversation is populated after switching away and back", async ({ chat, page }) => {
    await chat.open();
    // Several turns, so switching back goes through the /tail window plus the full replay path.
    const markers = ["alpha-111", "beta-222", "gamma-333", "delta-444", "epsilon-555"];
    for (const m of markers) {
      // sendTurn waits for this turn's reply by count, so an identical prior reply cannot
      // satisfy it early.
      await chat.sendTurn(`turn ${m}`, TURN_MS);
    }
    // All five user turns are present in the live thread.
    await expect(chat.userMessages()).toHaveCount(markers.length, { timeout: 30_000 });

    // Switch to a fresh conversation, then back; this turn funds a second conversation boot
    // on the full target.
    await page.locator(sidebar.newSession).click();
    await chat.send("a different conversation");
    await chat.waitForReply(/dummy agent/i, 100_000);

    await page.locator(sidebar.item).filter({ hasText: /turn alpha-111/i }).first().click();

    // The switched-back conversation must not be empty, and the latest turn is visible.
    await expect(chat.userMessages().filter({ hasText: /turn epsilon-555/i })).toHaveCount(1, { timeout: 30_000 });
    await expect(chat.userMessages()).toHaveCount(markers.length, { timeout: 30_000 });
    // And the other conversation's message is not bleeding in.
    await expect(chat.userMessages().filter({ hasText: /a different conversation/i })).toHaveCount(0);
  });

  test("a long conversation opens PINNED AT THE BOTTOM (not stranded at the top)", async ({ chat, page }) => {
    // Opening a long conversation must land at the bottom, so build a thread tall enough to
    // scroll first.
    await chat.open();
    const markers = ["m1-aa", "m2-bb", "m3-cc", "m4-dd", "m5-ee", "m6-ff", "m7-gg", "m8-hh"];
    for (const m of markers) {
      await chat.sendTurn(
        `turn ${m} — a moderately long line so the thread grows tall enough to scroll`,
        TURN_MS,
      );
    }
    await expect(chat.userMessages()).toHaveCount(markers.length, { timeout: 30_000 });

    // Switch away, then back.
    await page.locator(sidebar.newSession).click();
    await chat.send("elsewhere");
    await chat.waitForReply(/dummy agent/i, 100_000); // second conversation boot (see above)
    await page.locator(sidebar.item).filter({ hasText: /turn m1-aa/i }).first().click();

    // Fully repopulated…
    await expect(chat.userMessages()).toHaveCount(markers.length, { timeout: 30_000 });
    // …and the thread is genuinely scrollable (else the assertion is vacuous)…
    await expect.poll(() => chat.scrollableHeight(), { timeout: 10_000 }).toBeGreaterThan(200);
    // …and it opened pinned at the bottom (the latest turn visible, no scroll needed).
    await expect.poll(() => chat.distanceFromBottom(), { timeout: 10_000 }).toBeLessThanOrEqual(40);
    // The scroll-to-bottom arrow is disabled at the bottom (assistant-ui hides it).
    await expect(chat.scrollToBottomButton()).toBeDisabled({ timeout: 10_000 });
  });

  test("a longer conversation is populated after a full page reload", async ({ chat, page }) => {
    await chat.open();
    for (const m of ["one-aaa", "two-bbb", "three-ccc", "four-ddd"]) {
      // count-based wait, so no dropped turns
      await chat.sendTurn(`turn ${m}`, TURN_MS);
    }
    await expect(chat.userMessages()).toHaveCount(4, { timeout: 30_000 });

    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    // After reload the thread rebuilds via the tail seed + integrity replay and must be populated.
    await expect(chat.userMessages().filter({ hasText: /turn four-ddd/i })).toHaveCount(1, { timeout: 30_000 });
    await expect(chat.userMessages()).toHaveCount(4, { timeout: 30_000 });
  });
});
