/**
 * Tier 3 E2E — agent-presented option dropdown (AG-UI interrupt).
 *
 * The agent pauses the run with an interrupt carrying a set of options; the UI
 * renders them as inline buttons in the right-side panel's Approvals tab (the
 * RightPanel, auto-focused to Approvals on a new interrupt) and resumes the run with
 * the user's pick. Drives the fake agent's "?<prompt>" directive, which presents
 * Red/Green/Blue and reports the chosen one.
 */

import { test, expect, answerInterrupt, interruptSel } from "./fixtures.js";

const panel = {
  ...interruptSel,
  rightPanel: '[data-testid="right-panel"]',
  sandboxTab: '[data-testid="right-panel-tab-sandbox"]',
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
};

test.describe("agent option dropdown (interrupt)", () => {
  // On the full target a fresh conversation provisions a real sandbox before its first run
  // event, and the answer steps retry the click with 60-90s windows.
  test.beforeEach(() => test.setTimeout(180_000));

  test("the agent presents options; picking one resumes the run", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");

    // The right panel appears, auto-focused to the Approvals tab, with the options.
    await expect(page.locator(panel.rightPanel)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.approvalsTab)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    // Scoped to one card: a second interrupt can go pending at any moment, and a
    // whole-panel count then measures both cards' options together.
    const card = page.locator(panel.request).first();
    await expect(card.locator(panel.option)).toHaveCount(3, { timeout: 30_000 });
    await expect(card.locator(panel.option).filter({ hasText: /green/i })).toHaveCount(1);

    // Pick "Green" (answerInterrupt retries until the agent's continuation lands).
    await answerInterrupt(page, /green/i, /you picked: green/i);

    // The interrupt content goes away once answered; the right panel itself persists and
    // returns to the Sandbox tab.
    await expect(page.locator(panel.root)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(panel.rightPanel)).toBeVisible();
    await expect(page.locator(panel.sandboxTab)).toBeVisible();
  });

  test("dismissing the request cancels it", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");

    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });

    // Dismiss; the agent reports the cancellation and the interrupt content clears.
    await answerInterrupt(page, null, /you picked: \(cancelled\)/i);
    await expect(page.locator(panel.root)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(panel.rightPanel)).toBeVisible();
    await expect(page.locator(panel.sandboxTab)).toBeVisible();
  });
});
