/**
 * Tier 3 E2E for conversation history (especially tool calls) surviving a page refresh. The
 * open conversation renders solely from the integrity SSE stream, which replays the full
 * persisted event log on (re)connect, so a reload rebuilds purely from that replay and
 * proves tool-call events are persisted and faithfully re-materialized.
 */

import { test, expect } from "./fixtures.js";

test.describe("history survives a page refresh", () => {
  test("a tool call is still rendered after reload", async ({ chat, page }) => {
    await chat.open();
    // "!" runs a real sandbox command, so the bridge emits TOOL_CALL events that are persisted.
    await chat.send("!echo zxcvbnm-marker");

    // Live: the tool call renders and its output flows into the reply.
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 30_000 });
    await expect(chat.assistantMessages().last()).toContainText(/zxcvbnm-marker/i, { timeout: 30_000 });

    // Reload: all live state is gone and the page rebuilds history purely from the replayed log.
    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    // The tool call, user message and assistant reply must reappear from the replay.
    await expect(chat.userMessages().first()).toContainText(/echo zxcvbnm-marker/i, { timeout: 30_000 });
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 30_000 });
    await expect(chat.assistantMessages().last()).toContainText(/zxcvbnm-marker/i, { timeout: 30_000 });
  });

  test("a multi-turn conversation with tool calls is intact after reload", async ({ chat, page }) => {
    await chat.open();
    await chat.send("!echo first-marker");
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 30_000 });
    await expect(chat.assistantMessages().last()).toContainText(/first-marker/i, { timeout: 30_000 });

    await chat.send("!echo second-marker");
    await expect(chat.toolCalls()).toHaveCount(2, { timeout: 30_000 });
    await expect(chat.assistantMessages().last()).toContainText(/second-marker/i, { timeout: 30_000 });

    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    // Both turns' tool calls replay from the log (not one, not zero).
    await expect(chat.toolCalls()).toHaveCount(2, { timeout: 30_000 });
    await expect(chat.userMessages()).toHaveCount(2, { timeout: 30_000 });
  });
});
