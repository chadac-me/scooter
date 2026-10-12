/**
 * Tier 3 E2E for long multi-turn conversations staying fully consistent: every turn must
 * render, nothing gets dropped, tool calls persist, and the whole transcript survives a
 * reload with the right counts.
 */

import { test, expect } from "./fixtures.js";

test.describe("long multi-turn conversation integrity", () => {
  // On the full target every turn is a real sandbox exec, the first waits for a cold pod,
  // and the switch-away test adds a second conversation boot.
  test.setTimeout(240_000);

  // The first turn of a conversation is the only one that waits for a cold sandbox pod
  // before its exec starts.
  const FIRST_TURN_MS = 90_000;

  test("12 back-and-forth turns all render (no dropped user or assistant messages)", async ({ chat }) => {
    await chat.open();
    const N = 12;
    await chat.sendTurn("turn number 1", FIRST_TURN_MS);
    for (let i = 2; i <= N; i++) await chat.sendTurn(`turn number ${i}`);
    // Every user turn and every assistant reply is present, with exact counts.
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });
    await expect(chat.assistantMessages()).toHaveCount(N, { timeout: 45_000 });
    // The last turn's text is actually in the transcript (not a stale earlier render).
    await expect(chat.userMessages().filter({ hasText: `turn number ${N}` })).toHaveCount(1);
  });

  test("a long conversation with TOOL CALLS every turn keeps all messages + tool cards", async ({ chat }) => {
    await chat.open();
    const N = 8;
    await chat.sendTurn("!echo turn-1", FIRST_TURN_MS);
    for (let i = 2; i <= N; i++) await chat.sendTurn(`!echo turn-${i}`);
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });
    // Each `!echo` turn ran a real sandbox command, so there is a tool card per turn.
    await expect.poll(async () => chat.toolCalls().count(), { timeout: 45_000 }).toBeGreaterThanOrEqual(N);
  });

  test("the full transcript SURVIVES a reload with the same counts (no loss, no duplication)", async ({ chat, page }) => {
    await chat.open();
    const N = 10;
    await chat.sendTurn("persist turn 1", FIRST_TURN_MS);
    for (let i = 2; i <= N; i++) await chat.sendTurn(`persist turn ${i}`);
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });

    await page.reload();
    // After a full reload the persisted log re-folds to exactly the same transcript.
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });
    await expect(chat.assistantMessages()).toHaveCount(N, { timeout: 45_000 });
    // Both the last and the first turn are present, matched exactly because "persist turn 1"
    // is a substring of "persist turn 10".
    await expect(chat.userMessages().filter({ hasText: `persist turn ${N}` })).toHaveCount(1);
    await expect(chat.userMessages().getByText("persist turn 1", { exact: true })).toHaveCount(1);
  });

  test("mid-conversation reload then CONTINUE — new turns append correctly after the reload", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("before reload 1", FIRST_TURN_MS);
    for (let i = 2; i <= 5; i++) await chat.sendTurn(`before reload ${i}`);
    await expect(chat.userMessages()).toHaveCount(5, { timeout: 45_000 });
    await page.reload();
    await expect(chat.userMessages()).toHaveCount(5, { timeout: 45_000 });
    // Continue the conversation after the reload — the count keeps growing correctly.
    await chat.sendTurn("after reload 1");
    await chat.sendTurn("after reload 2");
    await expect(chat.userMessages()).toHaveCount(7, { timeout: 45_000 });
  });

  test("the run status CLEARS after each turn (never a stuck 'working' between turns)", async ({ chat, page }) => {
    await chat.open();
    for (let i = 1; i <= 4; i++) {
      await chat.sendTurn(`clean turn ${i}`, i === 1 ? FIRST_TURN_MS : undefined);
      // Between turns the composer is idle, with Send available.
      await expect(page.locator(".aui-composer-send, [aria-label=\"Send message\"]").first()).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0);
    }
  });

  test("switching AWAY to a new conversation and BACK preserves the long one's transcript", async ({ chat, page }) => {
    await chat.open();
    const N = 8;
    // A per-run nonce so the sidebar row can be found by its own title rather than by
    // position on the shared fleet.
    const nonce = `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    await chat.sendTurn(`switchable ${nonce} 1`, FIRST_TURN_MS);
    for (let i = 2; i <= N; i++) await chat.sendTurn(`switchable ${nonce} ${i}`);
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });

    // New conversation, one turn, then back to the first; this turn funds a second
    // conversation boot on the full target.
    await page.locator('[data-testid="new-session"]').click();
    await chat.sendTurn("a different conversation", 100_000);
    // Back to the long one by title, since the row order reflects the whole fleet.
    const longRow = page
      .locator('[data-testid="session-item"]')
      .filter({ hasText: new RegExp(`switchable ${nonce}`, "i") })
      .first();
    await expect(longRow).toHaveCount(1, { timeout: 30_000 });
    await longRow.click();
    // The long conversation re-renders in full (no truncation / loss on switch-back).
    await expect(chat.userMessages()).toHaveCount(N, { timeout: 45_000 });
    await expect(chat.userMessages().filter({ hasText: `switchable ${nonce} ${N}` })).toHaveCount(1);
  });
});
