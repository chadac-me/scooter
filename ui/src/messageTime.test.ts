/** Labels for the click-to-show message timestamp. */
import { describe, it, expect } from "vitest";

import { formatMessageTime, formatMessageTimeFull, shouldToggleTimestamp } from "./messageTime.js";

const now = new Date(2026, 9, 20, 15, 0); // Oct 20 2026, 3:00 PM local
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();

describe("formatMessageTime", () => {
  it("shows just the time for today", () => {
    expect(formatMessageTime(at(2026, 9, 20, 14, 41), now, "en-US")).toMatch(/^2:41\sPM$/);
  });
  it("prefixes Yesterday for the previous calendar day", () => {
    expect(formatMessageTime(at(2026, 9, 19, 23, 5), now, "en-US")).toMatch(/^Yesterday 11:05\sPM$/);
  });
  it("shows month and day earlier in the year", () => {
    expect(formatMessageTime(at(2026, 9, 14, 14, 41), now, "en-US")).toMatch(/^Oct 14, 2:41\sPM$/);
  });
  it("includes the year for a previous year", () => {
    expect(formatMessageTime(at(2025, 9, 14, 14, 41), now, "en-US")).toMatch(/Oct 14, 2025/);
  });
  it("full label carries the date and time", () => {
    const full = formatMessageTimeFull(at(2026, 9, 14, 14, 41), "en-US");
    expect(full).toMatch(/2026/);
    expect(full).toMatch(/2:41/);
  });
});

describe("shouldToggleTimestamp", () => {
  const sel = (text: string) => ({ isCollapsed: text === "", toString: () => text }) as unknown as Selection;
  it("toggles on a plain click", () => {
    expect(shouldToggleTimestamp(null, sel(""))).toBe(true);
  });
  it("does not toggle while text is selected", () => {
    expect(shouldToggleTimestamp(null, sel("some text"))).toBe(false);
  });
});

describe("shouldToggleTimestamp on interactive targets", () => {
  const target = (matches: boolean) => ({ closest: () => (matches ? {} : null) }) as unknown as EventTarget;
  it("does not toggle on a link or button", () => {
    expect(shouldToggleTimestamp(target(true), null)).toBe(false);
  });
  it("toggles on plain message content", () => {
    expect(shouldToggleTimestamp(target(false), null)).toBe(true);
  });
});
