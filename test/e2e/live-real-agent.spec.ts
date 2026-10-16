/**
 * Tier 3 E2E for the whole-UI invariants against a live deployment driving a real agent.
 * The fake agent is deterministic and fast, so this points the same detector (snapshot +
 * assertConsistent + assertMatchesServer) at a real deployment running a real model, with
 * timing-agnostic assertions: the UI's surfaces must agree with each other and with the
 * server whenever it settles. Gated and non-destructive:
 *   RUN_LIVE_E2E=1 BASE_URL=https://scooter.odin.lan npx playwright test test/e2e/live-real-agent.spec.ts
 * creates its own conversations and never deletes anyone else's, and counts are asserted
 * as deltas from a baseline snapshot.
 */

import { test, expect, snapshot, assertConsistent, checkpoint, shot, type UiSnapshot } from "./fixtures.js";
import { fullOnly } from "./target.js";
import type { Page } from "@playwright/test";

/**
 * Two ways to run: live (RUN_LIVE_E2E=1) against a live deployment and a real model, or the
 * full target (CI k3d) where the fake agent runs over a real sandbox with real provisioning
 * and pod exec. Only the prompts that induce slowness or tool calls differ between them.
 */
const live = process.env.RUN_LIVE_E2E === "1";
const maybe = live
  ? test.describe
  : fullOnly(
      "real-cluster timing (sandbox provisioning, pod exec) is the point — the fast fake stack skips through the in-flight windows these tests probe; RUN_LIVE_E2E=1 runs them against a live deployment",
    );

/** A prompt that keeps a run genuinely in flight: a real model counting slowly, or the fake
 *  agent running a real `sleep 15` in the sandbox. */
const slowPrompt = (tail: string) =>
  live ? `Count slowly from 1 to 20, one number per line, then say ${tail}.` : "!sleep 15";

// A real turn can take a while (tool calls, cold sandbox, model latency), and the polls are
// event-driven so a fast turn costs nothing extra.
const TURN = 240_000;
test.setTimeout(600_000);

/** Snapshot + assert the cross-component invariants; return it for step assertions. */
async function step(page: Page, when: string): Promise<UiSnapshot> {
  return checkpoint(page, when);
}

/** Open a brand-new conversation so existing ones are never touched. */
async function newConversation(page: Page) {
  await page.goto("/");
  await expect(page.locator('[aria-label="Message input"]').first()).toBeVisible({ timeout: 60_000 });
  const btn = page.locator('[data-testid="new-session"]');
  if (await btn.count()) await btn.first().click();
  await expect(page.locator('[aria-label="Message input"]').first()).toBeVisible({ timeout: 60_000 });
}

/** Send and wait for the reply, tolerating real-model latency. Returns the settled snapshot. */
async function liveTurn(page: Page, chat: { sendWhileRunning: (t: string) => Promise<void> }, text: string): Promise<UiSnapshot> {
  const before = await snapshot(page);
  await chat.sendWhileRunning(text);
  await expect
    .poll(async () => (await snapshot(page)).assistantMessages, { timeout: TURN })
    .toBeGreaterThan(before.assistantMessages);
  await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: TURN });
  await shot(page, `settled-${text.slice(0, 30)}`);
  return snapshot(page);
}

maybe("live deployment, real agent", () => {
  test("a real turn keeps every UI surface mutually consistent", async ({ chat, page }) => {
    await newConversation(page);
    const idle = await step(page, "fresh live conversation");
    expect(idle.runError, "a fresh conversation shows no error").toBeNull();

    await chat.sendWhileRunning("Reply with exactly: LIVE-OK");
    // While the real model works, the UI must stay internally coherent.
    for (let i = 0; i < 12; i++) {
      await step(page, `during a real run (probe ${i + 1})`);
      await page.waitForTimeout(2_000);
      if ((await snapshot(page)).assistantMessages > idle.assistantMessages) break;
    }
    await expect
      .poll(async () => (await snapshot(page)).assistantMessages, { timeout: TURN })
      .toBeGreaterThan(idle.assistantMessages);
    await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: TURN });

    const done = await step(page, "after a real turn");
    expect(done.userMessages, "exactly one new user turn").toBe(idle.userMessages + 1);
    expect(done.composerSendable, "the composer returns to Send").toBe(true);
    expect(done.queued, "no phantom queue rows").toEqual([]);
  });

  test("a real TOOL CALL leaves the UI consistent (real sandbox, real pods/exec)", async ({ chat, page }) => {
    await newConversation(page);
    const before = await snapshot(page);
    // A real shell command through the real in-cluster exec path.
    const s = await liveTurn(
      page,
      chat,
      live ? "Run the shell command `echo LIVE-TOOL-OK` and tell me its output." : "!echo LIVE-TOOL-OK",
    );
    assertConsistent(s, "after a real tool call");
    expect(s.toolCards, "a real tool call rendered a card").toBeGreaterThan(before.toolCards);
    expect(s.runError, "a successful tool call leaves no error").toBeNull();
    expect(s.running, "the run ended").toBe(false);
  });

  test("QUEUEING against a real (slow) run: the message queues, then drains exactly once", async ({ chat, page }) => {
    await newConversation(page);
    const before = await snapshot(page);

    // A genuinely slow task so there is a real in-flight window to queue behind.
    await chat.sendWhileRunning(slowPrompt("DONE-SLOW"));
    // Best-effort: wait for the run to look in-flight, but do not fail if a fast turn beat us there.
    await expect(page.locator('[data-testid="run-status-bar"]'))
      .toBeVisible({ timeout: 60_000 })
      .catch(() => {});
    await shot(page, "long-real-run-in-flight");
    await chat.sendWhileRunning("QUEUED-LIVE: reply with exactly QUEUED-OK");
    // It must appear in the queue while the real run is still going.
    await expect
      .poll(async () => (await snapshot(page)).queued.join("|"), { timeout: 60_000 })
      .toContain("QUEUED-LIVE");
    assertConsistent(await snapshot(page), "queued behind a real run");

    // Both turns complete; the queued message ran exactly once.
    await expect.poll(async () => (await snapshot(page)).queued.length, { timeout: TURN }).toBe(0);
    await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: TURN });
    const done = await step(page, "after the live queue drained");
    expect(done.userMessages, "both turns are in the transcript").toBe(before.userMessages + 2);
    expect(
      await page.locator(".aui-user-message-content").filter({ hasText: "QUEUED-LIVE" }).count(),
      "the queued message ran exactly once",
    ).toBe(1);
  });

  test("a RELOAD mid-real-run re-folds correctly (no lost turn, no stuck 'working')", async ({ chat, page }) => {
    await newConversation(page);
    const before = await snapshot(page);
    await chat.sendWhileRunning(slowPrompt("RELOAD-OK"));
    // The run bar is not required to be visible: the property under test is that a reload at
    // an arbitrary moment re-folds correctly.
    await page.waitForTimeout(1_500);
    await shot(page, "just-before-reload-mid-real-run");
    await page.reload();
    await expect(page.locator('[aria-label="Message input"]').first()).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => (await snapshot(page)).assistantMessages, { timeout: TURN })
      .toBeGreaterThan(before.assistantMessages);
    await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: TURN });

    const s = await step(page, "after a reload mid-real-run");
    expect(s.composerSendable, "not stuck working after the reload").toBe(true);
    expect(s.userMessages, "the turn was not lost or duplicated").toBe(before.userMessages + 1);
  });

  test("a MULTI-TURN real conversation keeps exact counts and stays consistent throughout", async ({ chat, page }) => {
    await newConversation(page);
    const before = await snapshot(page);
    for (let i = 1; i <= 4; i++) {
      const s = await liveTurn(page, chat, `Turn ${i}: reply with exactly TURN-${i}-OK`);
      assertConsistent(s, `after live turn ${i}`);
      expect(s.userMessages, `live turn ${i}: exact user count`).toBe(before.userMessages + i);
      expect(s.assistantMessages, `live turn ${i}: exact assistant count`).toBe(before.assistantMessages + i);
      expect(s.queued, `live turn ${i}: no phantom queue`).toEqual([]);
      expect(s.runError, `live turn ${i}: no error`).toBeNull();
    }
  });
});
