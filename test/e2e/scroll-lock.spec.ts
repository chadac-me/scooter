/**
 * Tier 3 E2E for the conversation scroll-lock. The thread viewport (assistant-ui
 * ThreadPrimitive.Viewport) is bottom-anchored, so as turns stream in the view follows the
 * latest content; the lock releases when the user scrolls up, and the scroll-to-bottom
 * arrow re-engages it.
 */

import { test, expect, type Chat } from "./fixtures.js";

// "At the bottom" tolerance in px: smooth scrolling and sub-pixel rounding leave a few px
// of slop after the settle, far below a message's height.
const AT_BOTTOM_PX = 40;

// Fill the thread until it is comfortably taller than the viewport, so the scroll
// assertions are not vacuous, and return the scrollable height.
async function fillUntilScrollable(chat: Chat, minScroll = 400): Promise<number> {
  let scrollable = 0;
  for (let i = 0; i < 12 && scrollable < minScroll; i++) {
    // On the full target every turn execs in a real sandbox and the first one waits for a cold pod.
    await chat.sendTurn(
      `turn number ${i} — please review something moderately long so the thread grows`,
      90_000,
    );
    scrollable = await chat.scrollableHeight();
  }
  return scrollable;
}

test.describe("conversation scroll-lock", () => {
  // fillUntilScrollable sends up to 12 turns, each a real sandbox exec on the full target.
  test.setTimeout(360_000);

  test("auto-follows new turns to the bottom", async ({ chat }) => {
    await chat.open();
    const scrollable = await fillUntilScrollable(chat);
    expect(scrollable, "thread never grew tall enough to scroll — assertion would be vacuous").toBeGreaterThan(0);

    // With scroll-lock on, the viewport rode each new turn down to the bottom.
    await chat.settleAtBottom();
    // At the bottom the scroll-to-bottom arrow is disabled; the store's isAtBottom flag
    // updates on a scroll event, which can trail the settle.
    await expect(chat.scrollToBottomButton()).toBeDisabled({ timeout: 10_000 });
  });

  test("a BIG single-frame message does NOT break the auto-follow (the reported bug)", async ({ chat, page }) => {
    // A long message appended in one layout frame jumps scrollHeight by far more than
    // assistant-ui's bottom threshold while scrollTop is unchanged, and useStickToBottom
    // must keep the view pinned across that jump.
    await chat.open();
    await fillUntilScrollable(chat);
    await chat.settleAtBottom();

    const viewportH = await chat.viewport().evaluate((el) => el.clientHeight);
    // A single message ~4 viewports tall; newlines force real vertical growth.
    const bigLines = Math.ceil((viewportH / 20) * 4);
    const huge = Array.from({ length: bigLines }, (_, i) => `line ${i} of a very long pasted block`).join("\n");

    await chat.send(huge);
    // The user bubble renders in one frame on send, so wait until that big append landed.
    await expect.poll(() => chat.scrollableHeight(), { timeout: 10_000 }).toBeGreaterThan(viewportH);

    // Assert on the peak distance across the settle window, since the library eventually
    // crawls back on its own; one viewport height separates pinned from stranded.
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      peak = Math.max(peak, await chat.distanceFromBottom());
      await page.waitForTimeout(40);
    }
    expect(peak, "the view was stranded away from the bottom after a big append").toBeLessThan(viewportH);
    await expect(chat.scrollToBottomButton()).toBeDisabled({ timeout: 10_000 });
  });

  test("scrolling up releases the lock; the arrow re-engages it", async ({ chat, page }) => {
    await chat.open();
    const scrollable = await fillUntilScrollable(chat);
    expect(scrollable, "thread never grew tall enough to scroll").toBeGreaterThan(0);
    await chat.settleAtBottom();

    // Release the lock with a real wheel gesture, since useStickToBottom only durably
    // releases on a user scroll gesture and re-pins after a programmatic scrollTo;
    // re-wheel on each poll tick until the arrow is enabled and the view sits above the
    // tolerance.
    const box = await chat.viewport().boundingBox();
    expect(box, "thread viewport has no bounding box").not.toBeNull();
    const wheelX = box!.x + box!.width / 2;
    const wheelY = box!.y + box!.height / 2;
    // Wheel by well more than the scrollable height, with a floor for a short thread.
    const wheelDelta = Math.max(600, scrollable);
    await expect
      .poll(
        async () => {
          await page.mouse.move(wheelX, wheelY);
          await page.mouse.wheel(0, -wheelDelta);
          return (await chat.scrollToBottomButton().isEnabled()) && (await chat.distanceFromBottom()) > AT_BOTTOM_PX;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // The wheel gesture escaped the lock durably, so the arrow stays enabled until it is clicked.
    await expect(chat.scrollToBottomButton()).toBeEnabled();

    // Clicking the arrow re-engages the lock.
    await chat.scrollToBottomButton().click();
    await expect.poll(() => chat.distanceFromBottom(), { timeout: 5_000 }).toBeLessThanOrEqual(AT_BOTTOM_PX);
    await expect(chat.scrollToBottomButton()).toBeDisabled();
  });
});
