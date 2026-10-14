/**
 * Tier 3 E2E for SSE resilience: the live UI must recover from a dropped, stalled or killed
 * integrity frame rather than wedge. Faults are injected by the SSE fault proxy
 * (test/e2e/support/faultProxy.mjs) between the UI dev server and the agent-host; each test
 * sets a fault, drives a normal turn, and asserts the UI recovers via the idle-watchdog
 * reconnect, which the e2e UI runs with a small VITE_IDLE_RECONNECT_MS (2s).
 */

import { test, expect } from "./fixtures.js";
import { fastOnly } from "./target.js";

// The proxy's control endpoint (it listens on 8090; the UI proxies to it).
const PROXY = "http://localhost:8090";

async function setFault(request: import("@playwright/test").APIRequestContext, fault: Record<string, unknown>) {
  const res = await request.post(`${PROXY}/__fault`, { data: fault });
  expect(res.ok()).toBeTruthy();
}
async function clearFault(request: import("@playwright/test").APIRequestContext) {
  await setFault(request, { mode: "none" });
}

fastOnly("needs the SSE fault proxy to drop/stall/kill stream frames")("SSE resilience", () => {
  // Only this spec drives the isolated fault-proxy stack (a second UI dev server on 5273
  // through the fault proxy on 8090).
  test.use({ baseURL: "http://localhost:5273" });

  // Clear the fault after each test so a leak cannot wedge the next one.
  test.afterEach(async ({ request }) => {
    await clearFault(request);
  });

  test("dropped RUN_FINISHED — the idle-watchdog reconnect un-sticks the run; the user can send again", async ({ chat, page, request }) => {
    await chat.open();
    // Establish a healthy conversation first, with no fault active.
    await chat.sendTurn("first, a normal turn");

    // Drop the next RUN_FINISHED frame once on the live stream; the persisted log still has
    // it, so the idle-watchdog reconnect re-folds it.
    await setFault(request, { mode: "drop", eventType: "RUN_FINISHED" });
    await chat.send("this run's finish will be dropped");

    // The 2nd turn's reply finalizes and the composer un-sticks once the reconnect re-folds
    // the persisted log.
    await expect(chat.assistantMessages()).toHaveCount(2, { timeout: 30_000 });
    const sendBtn = page.locator(".aui-composer-send, [aria-label=\"Send message\"]").first();
    await expect(sendBtn).toBeVisible({ timeout: 15_000 });

    // The real proof it is not dead: a new message sends and gets its own reply.
    await chat.sendTurn("am I still alive?");
    await expect(chat.userMessages()).toHaveCount(3, { timeout: 30_000 });
    await expect(chat.assistantMessages()).toHaveCount(3, { timeout: 30_000 });
  });

  test("killAfter mid-stream — the reconnect re-folds; the reply completes with no duplicate", async ({ chat, page, request }) => {
    await chat.open();
    await chat.sendTurn("baseline turn");

    // Kill the integrity connection after a few frames; the UI must reconnect and re-fold
    // rather than lose or double the turn.
    await setFault(request, { mode: "killAfter", n: 3 });
    await chat.send("survive a mid-stream kill");

    // The turn still resolves after reconnect, with exactly one new assistant message.
    await expect(chat.userMessages()).toHaveCount(2, { timeout: 30_000 });
    await expect(chat.assistantMessages()).toHaveCount(2, { timeout: 30_000 });
    // Composer is usable again.
    await expect(page.locator(".aui-composer-send, [aria-label=\"Send message\"]").first()).toBeVisible({ timeout: 15_000 });
  });

  test("stalled stream — messages arrive late but correctly, no error box", async ({ chat, request }) => {
    await chat.open();
    await chat.sendTurn("pre-stall turn");

    // Hold the next stream for 1.5s, then resume: delivery is slow but complete.
    await setFault(request, { mode: "stall", stallMs: 1500 });
    await chat.send("delivered slowly");

    // The reply still lands, just later.
    await expect(chat.userMessages()).toHaveCount(2, { timeout: 30_000 });
    await expect(chat.assistantMessages().nth(1)).toBeVisible({ timeout: 30_000 });
  });

  test("expired ingress auth (401 on the stream) surfaces a clear error, not a silent hang", async ({ chat, page, request }) => {
    await chat.open();
    await chat.sendTurn("before the session expires");

    // The integrity stream now 401s, which the UI must surface rather than sit forever
    // pretending the agent is alive.
    await setFault(request, { mode: "authExpire" });

    // Force a fresh stream connection (reload) so it hits the 401.
    await page.reload();

    // The app must show the durable "session expired" banner.
    await expect(page.getByTestId("stream-auth-error-bar")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("stream-auth-error-message")).toContainText(/session expired/i);

    // Once the fault is cleared the banner self-clears with no reload required.
    await clearFault(request);
    await expect(page.getByTestId("stream-auth-error-bar")).toBeHidden({ timeout: 15_000 });
  });
});
