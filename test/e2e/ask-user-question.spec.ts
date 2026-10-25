/**
 * Tier 3 E2E: the agent asks the user a question (AskUserQuestion) and blocks until it is answered.
 *
 * Drives the fake agent's "??<question>" directive, which asks one Postgres/SQLite question over
 * the permission round-trip and reports the answer it got back. The UI renders the question card
 * in the Approvals tab and the sidebar marks the conversation "!", and the answer resumes the same run.
 */

import { test, expect } from "./fixtures.js";

const sel = {
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
  panel: '[data-testid="interrupt-panel"]',
  card: '[data-testid="question-request"]',
  text: '[data-testid="question-text"]',
  option: '[data-testid="question-option"]',
  other: '[data-testid="question-other"]',
  submit: '[data-testid="question-submit"]',
  dismiss: '[data-testid="interrupt-cancel"]',
  waitingDot: '[data-testid="session-status-dot"][data-dot="question"]',
};

test.describe("agent asks the user a question", () => {
  // On the full target a fresh conversation provisions a real sandbox before its first run event.
  test.beforeEach(() => test.setTimeout(180_000));

  test("picking an option sends the answer back to the waiting agent", async ({ chat, page }) => {
    await chat.open();
    await chat.send("??Which database should we use?");

    await expect(page.locator(sel.card)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(sel.approvalsTab)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(sel.text)).toHaveText("Which database should we use?");
    await expect(page.locator(sel.option)).toHaveCount(2);
    // Nothing is chosen yet, so there is nothing to send.
    await expect(page.locator(sel.submit)).toBeDisabled();
    // The sidebar marks the conversation as waiting on the user.
    await expect(page.locator(sel.waitingDot)).toHaveCount(1, { timeout: 30_000 });

    const sqlite = page.locator(sel.option).filter({ hasText: "SQLite" });
    await sqlite.click();
    await expect(sqlite).toHaveAttribute("aria-checked", "true");

    // Re-submit while the card is up, because a click made before the resume is wired never lands.
    await expect(async () => {
      if (await page.locator(sel.card).isVisible().catch(() => false)) {
        await page.locator(sel.submit).click({ timeout: 5_000 }).catch(() => {});
      }
      await expect(page.getByText(/you answered: SQLite/).first()).toBeVisible({ timeout: 15_000 });
    }).toPass({ timeout: 90_000 });
    await expect(page.locator(sel.panel)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(sel.waitingDot)).toHaveCount(0, { timeout: 30_000 });
  });

  test("a typed answer replaces the options", async ({ chat, page }) => {
    await chat.open();
    await chat.send("??Which database should we use?");

    await expect(page.locator(sel.card)).toBeVisible({ timeout: 30_000 });
    await page.locator(sel.option).filter({ hasText: "Postgres" }).click();
    await page.locator(sel.other).fill("DuckDB");
    // Typing clears the single-select pick, so the card never sends two answers.
    await expect(page.locator(sel.option).filter({ hasText: "Postgres" })).toHaveAttribute("aria-checked", "false");

    await expect(async () => {
      if (await page.locator(sel.card).isVisible().catch(() => false)) {
        await page.locator(sel.submit).click({ timeout: 5_000 }).catch(() => {});
      }
      await expect(page.getByText(/you answered: DuckDB/).first()).toBeVisible({ timeout: 15_000 });
    }).toPass({ timeout: 90_000 });
  });

  test("dismissing the question tells the agent it was not answered", async ({ chat, page }) => {
    await chat.open();
    await chat.send("??Which database should we use?");

    const dismiss = page.locator(sel.card).locator(sel.dismiss);
    await expect(dismiss).toBeEnabled({ timeout: 30_000 });
    await expect(async () => {
      if (await page.locator(sel.card).isVisible().catch(() => false)) {
        await dismiss.click({ timeout: 5_000 }).catch(() => {});
      }
      await expect(page.getByText(/question dismissed/).first()).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.locator(sel.panel)).toHaveCount(0, { timeout: 10_000 });
  });
});
