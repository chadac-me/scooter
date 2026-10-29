/**
 * The fold gate decides whether a folded message list is painted.
 *
 * It suppresses a list that shrinks within one fold, but a reconnect re-folds from
 * empty over the trailing window, so the high-water mark must reset per fold
 * generation or the transcript freezes.
 */

import { describe, it, expect } from "vitest";

import { createFoldGate } from "./RuntimeProvider.js";

describe("createFoldGate", () => {
  it("accepts a list that grows within one fold", () => {
    const gate = createFoldGate();
    expect(gate.accept(1, 0)).toBe(true);
    expect(gate.accept(1, 5)).toBe(true);
    expect(gate.accept(1, 5)).toBe(true); // unchanged length still paints
    expect(gate.accept(1, 12)).toBe(true);
  });

  it("suppresses a shrink WITHIN one fold (the mid-render index crash)", () => {
    const gate = createFoldGate();
    gate.accept(1, 12);
    expect(gate.accept(1, 3)).toBe(false);
    expect(gate.accept(1, 11)).toBe(false);
    expect(gate.accept(1, 12)).toBe(true); // back to the high-water mark
  });

  it("lets a RECONNECT's shorter re-fold through (the latch)", () => {
    const gate = createFoldGate();
    gate.accept(1, 200); // the trailing window
    gate.accept(1, 350); // the user scrolled back; older history paged in

    // Reconnect: a new fold, re-folded from empty over the window alone.
    expect(gate.accept(2, 200)).toBe(true);
    // It keeps painting as live messages arrive.
    expect(gate.accept(2, 201)).toBe(true);
  });

  it("re-arms its shrink protection per fold", () => {
    const gate = createFoldGate();
    gate.accept(1, 40);
    expect(gate.accept(2, 200)).toBe(true);
    // Within the new fold, a shrink is still suppressed.
    expect(gate.accept(2, 7)).toBe(false);
  });

  it("does not assume generations increase by one, or at all", () => {
    const gate = createFoldGate();
    gate.accept(0, 9);
    expect(gate.accept(0, 4)).toBe(false); // generation 0 is a real generation
    expect(gate.accept(7, 4)).toBe(true); // a jump is just a different fold
  });
});
