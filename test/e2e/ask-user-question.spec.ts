/**
 * Tier 3 E2E: the agent asks the user a question and blocks until it is answered, drawn by the
 * ask-user contrib's card through the Approvals-tab renderer slot.
 *
 * Drives the fake agent's "??<question>" directive, which raises one `ask-user.questions` request
 * over the permission round-trip and reports the answer it got back. The manifest is served by a
 * route, since the fast stack's vite dev server has none; the card is the contrib's real ui/ file.
 * The sidebar marks the conversation "!", and the answer resumes the same run. Without a usable
 * renderer the request falls back to the core's plain Answer/Dismiss card.
 */

import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const CARD = { contrib: "ask-user", entry: "ask-user/ui/QuestionCard.tsx" };

async function serveRenderers(page: Page, interruptRenderers: Record<string, unknown>) {
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sources: {}, toolCards: {}, toolTitles: {}, linkProviders: [], approvals: {}, settingsTabs: {}, interruptRenderers }),
    }),
  );
}

const sel = {
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
  panel: '[data-testid="interrupt-panel"]',
  card: '[data-testid="question-request"]',
  text: '[data-testid="question-text"]',
  option: '[data-testid="question-option"]',
  other: '[data-testid="question-other"]',
  submit: '[data-testid="question-submit"]',
  dismiss: '[data-testid="interrupt-cancel"]',
  plain: '[data-testid="interrupt-request"]',
  plainOption: '[data-testid="interrupt-option"]',
  rendererError: '[data-testid="contrib-interrupt-error"]',
  waitingDot: '[data-testid="session-status-dot"][data-dot="question"]',
};

test.describe("agent asks the user a question", () => {
  // On the full target a fresh conversation provisions a real sandbox before its first run event.
  test.beforeEach(() => test.setTimeout(180_000));

  test.describe("with the ask-user card in the manifest", () => {
    test.beforeEach(({ page }) => serveRenderers(page, { "ask-user.questions": CARD }));

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

  test("without the contrib's card, the request falls back to Answer and Dismiss", async ({ chat, page }) => {
    await serveRenderers(page, {});
    await chat.open();
    await chat.send("??Which database should we use?");

    await expect(page.locator(sel.plain)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(sel.card)).toHaveCount(0);
    await expect(page.locator(sel.plainOption)).toHaveText(["Answer"]);
    await expect(async () => {
      if (await page.locator(sel.plain).isVisible().catch(() => false)) {
        await page.locator(sel.plain).locator(sel.dismiss).click({ timeout: 5_000 }).catch(() => {});
      }
      await expect(page.getByText(/question dismissed/).first()).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 60_000 });
  });

  test("a card the UI build lacks shows an error with the fallback buttons under it", async ({ chat, page }) => {
    await serveRenderers(page, { "ask-user.questions": { ...CARD, entry: "ask-user/ui/Missing.tsx" } });
    await chat.open();
    await chat.send("??Which database should we use?");

    const error = page.locator(sel.rendererError);
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error.locator(sel.plainOption)).toHaveText(["Answer"]);
    await expect(error.locator(sel.dismiss)).toBeEnabled();
  });
});
