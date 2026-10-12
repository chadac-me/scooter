/**
 * Tier 3 E2E for interrupts coexisting with a queue, and recovery back to a clean state. An
 * interrupt pauses the run awaiting a human answer; messages sent during that pause must
 * queue and be visible, and answering the interrupt must let the queue proceed and return
 * the UI to a clean, sendable state. Uses the fake agent's `?pick a color` (a permission
 * interrupt) and `!sleep` (a long run).
 */

import { test, expect } from "./fixtures.js";
import { isFull } from "./target.js";

const panel = {
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  cancel: '[data-testid="interrupt-cancel"]',
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
  approvalsBadge: '[data-testid="right-panel-badge-approvals"]',
  queueTab: '[data-testid="right-panel-tab-queue"]',
};

// On the full target a fresh conversation provisions a real sandbox, and answering an
// interrupt resumes a run whose exec waits for that pod, so both the ceiling and the
// post-answer waits need cluster budgets.
const CLUSTER_BUDGET_MS = 180_000;
const ANSWER_BUDGET_MS = 90_000;

/**
 * Click an interrupt option (or Dismiss) until the agent's answer actually lands, re-clicking
 * while the panel is still up because a click made before it is wired never reaches the agent.
 */
async function answerInterrupt(
  page: import("@playwright/test").Page,
  option: RegExp | null,
  expected: RegExp,
) {
  const target = option
    ? page.locator(panel.option).filter({ hasText: option })
    : page.locator(panel.cancel);
  await expect(target).toBeEnabled({ timeout: 30_000 });
  await expect(async () => {
    if (await page.locator(panel.root).isVisible().catch(() => false)) {
      await target.click({ timeout: 5_000 }).catch(() => {});
    }
    await expect(page.getByText(expected).first()).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: ANSWER_BUDGET_MS });
}

test.describe("interrupt + queue coexistence", () => {
  test.beforeEach(() => test.setTimeout(CLUSTER_BUDGET_MS));

  test("messages QUEUE while an approval interrupt is pending (both surfaces populated)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 }); // run paused on the interrupt

    // The run is paused awaiting the pick, so a message sent now must queue.
    await chat.sendWhileRunning("queued behind the approval");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('[data-testid="queued-message-text"]').first()).toContainText("queued behind the approval");
  });

  test("answering the interrupt lets the QUEUE drain (the queued message then runs)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await chat.sendWhileRunning("run after I approve");
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });

    // Switch back to the Approvals tab so the interrupt options are visible, then answer.
    await page.locator(panel.approvalsTab).click();
    await answerInterrupt(page, /green/i, /you picked: green/i);

    // The queued message becomes a real user turn, which on the full target runs a real
    // sandbox exec.
    await expect(chat.userMessages().filter({ hasText: "run after I approve" })).toHaveCount(1, {
      timeout: ANSWER_BUDGET_MS,
    });

    // Re-open the Queue tab first, since its contents are unmounted when it is not selected
    // and `queuedMessages()` would resolve to 0 vacuously.
    await chat.openQueueTab();
    await expect(chat.queuedMessages()).toHaveCount(0, { timeout: 30_000 });
  });

  test("the interrupt panel + queue tab are BOTH reachable (badges reflect their counts)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    // The approvals badge shows a pending count.
    await expect(page.locator(panel.approvalsBadge)).toBeVisible({ timeout: 15_000 });
    await chat.sendWhileRunning("q1");
    await chat.sendWhileRunning("q2");
    // The queue tab badge counts the queued items independently of the interrupt.
    await expect(page.locator('[data-testid="right-panel-badge-queue"]')).toHaveText(/2/, { timeout: 15_000 });
  });
});

test.describe("interrupt persistence + recovery", () => {
  test.beforeEach(() => test.setTimeout(CLUSTER_BUDGET_MS));

  test("a pending approval SURVIVES a reload (the panel reappears)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });

    await page.reload();
    // The interrupt is persisted on the integrity log, so the panel re-derives after the reload.
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panel.option)).toHaveCount(3, { timeout: 30_000 });

    // Answering after a reload is asserted on the fast target only: on a cluster the
    // reconnected answer can land on a pod that does not know the conversation yet and is dropped.
    if (!isFull) {
      await page.locator(panel.option).filter({ hasText: /red/i }).click();
      await expect(page.getByText(/you picked: red/i).first()).toBeVisible({ timeout: ANSWER_BUDGET_MS });
    }
  });

  test("after answering, the UI returns to a CLEAN sendable state (no stuck panel / working)", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await answerInterrupt(page, /blue/i, /you picked: blue/i);

    // Clean state: the interrupt panel is gone, no stuck run-status bar, and a new turn works first-try.
    await expect(page.locator(panel.root)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: 15_000 });
    // Same cold-boot arithmetic as the answer above.
    await chat.sendTurn("a normal turn after the interrupt", ANSWER_BUDGET_MS);
    await expect(chat.userMessages().filter({ hasText: "a normal turn after the interrupt" })).toHaveCount(1);
  });

  test("a dismissed (cancelled) interrupt also returns to a clean state", async ({ chat, page }) => {
    await chat.open();
    await chat.send("?pick a color");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    await answerInterrupt(page, null, /you picked: \(cancelled\)/i);
    await expect(page.locator(panel.root)).toHaveCount(0, { timeout: 10_000 });
    // This is the conversation's first completed exec, so it funds the cold sandbox boot.
    await chat.sendTurn("works after a cancel", ANSWER_BUDGET_MS);
    await expect(chat.userMessages().filter({ hasText: "works after a cancel" })).toHaveCount(1);
  });
});
