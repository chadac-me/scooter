/**
 * The inline-rename blur rule. It gets its own unit because the e2e that covered renaming is
 * skipped on the 2-core runner, and because the rule guards something much larger than the
 * input: an open rename holds the conversation-list stream back, so an input that is "open"
 * with nothing focused freezes the sidebar in that tab until a reload.
 */

import { describe, it, expect } from "vitest";

import { renameStaysOpen } from "./HeaderConversationTitle.js";

describe("renameStaysOpen", () => {
  it("keeps the input open when focus moves within the rename control", () => {
    // Focus moving to a sibling inside the header rename control is not a click-away.
    expect(renameStaysOpen(true, true)).toBe(true);
  });

  it("commits when focus moves to something outside the rename control", () => {
    expect(renameStaysOpen(true, false)).toBe(false);
  });

  it("commits when the blur has NO next target", () => {
    // Clicking non-focusable page background, or switching window/tab, blurs with a null
    // relatedTarget. Treating that as "still editing" stranded the rename lock, and with the
    // lock held the sidebar stops applying stream frames entirely.
    expect(renameStaysOpen(false, false)).toBe(false);
  });

  it("never keeps the input open on a null target, whatever the container says", () => {
    expect(renameStaysOpen(false, true)).toBe(false);
  });
});
