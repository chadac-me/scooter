/**
 * Tier 1 contract for the container's reconnect backoff: a long-lived process on the
 * user's machine reconnecting to a single-replica cloud that is rolled out regularly, so
 * the backoff must be exponential, jittered, capped and never zero.
 */

import { describe, it, expect } from "vitest";

import { nextReconnectDelay, RECONNECT_BASE_MS, RECONNECT_CAP_MS } from "../src/reconnect.js";

describe("container reconnect backoff", () => {
  it("the first retry is prompt — a rollout should not feel like an outage", () => {
    const d = nextReconnectDelay(1, () => 0.5);
    expect(d).toBeGreaterThanOrEqual(RECONNECT_BASE_MS * 0.5);
    expect(d).toBeLessThanOrEqual(RECONNECT_BASE_MS * 1.5);
  });

  it("backs off exponentially across attempts", () => {
    const mid = () => 0.5; // fixed jitter, so the growth is visible
    const d1 = nextReconnectDelay(1, mid);
    const d2 = nextReconnectDelay(2, mid);
    const d3 = nextReconnectDelay(3, mid);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
  });

  it("is CAPPED — a long outage must not back off to hours", () => {
    // An uncapped doubling would leave a user's agent offline long after the controller came back.
    for (const attempt of [10, 20, 50, 100]) {
      for (const r of [0, 0.5, 1]) {
        expect(nextReconnectDelay(attempt, () => r), `attempt ${attempt}, jitter ${r}`)
          .toBeLessThanOrEqual(RECONNECT_CAP_MS);
      }
    }
    // The cap must bind: by attempt 10 the raw exponential is far past it, so full jitter sits exactly at the cap.
    expect(nextReconnectDelay(10, () => 1)).toBe(RECONNECT_CAP_MS);
  });

  it("applies JITTER so containers do not retry in lockstep", () => {
    // Without jitter every container stays synchronised after a rollout.
    const low = nextReconnectDelay(5, () => 0);
    const high = nextReconnectDelay(5, () => 1);
    expect(high).toBeGreaterThan(low);
  });

  it("never returns a negative or zero delay (a busy-loop would pin the user's CPU)", () => {
    for (const attempt of [1, 2, 3, 10, 100]) {
      for (const r of [0, 0.5, 1]) {
        expect(nextReconnectDelay(attempt, () => r)).toBeGreaterThan(0);
      }
    }
  });

  it("attempt 0 or negative is treated as the first attempt (defensive)", () => {
    expect(nextReconnectDelay(0, () => 0.5)).toBeGreaterThan(0);
    expect(nextReconnectDelay(-5, () => 0.5)).toBeGreaterThan(0);
  });
});

// --- closeDisposition: the close-code policy ------------------------------------------------

import {
  closeDisposition,
  CLOSE_AUTH_REJECTED,
  CLOSE_SUPERSEDED,
  AUTH_RETRY_MS,
  SUPERSEDED_RETRY_MS,
} from "../src/reconnect.js";

describe("closeDisposition", () => {
  it("AUTH REJECTION is loud and slow — the observed silent-fast-loop failure", () => {
    const d = closeDisposition(CLOSE_AUTH_REJECTED, "join token expired", 1);
    expect(d.message).toMatch(/AUTHENTICATION FAILED/);
    expect(d.message).toMatch(/join token expired/);
    expect(d.message).toMatch(/Settings/); // where the human gets a fresh command
    expect(d.delayMs).toBe(AUTH_RETRY_MS);
  });

  it("SUPERSEDED backs off so two containers for one owner cannot ping-pong", () => {
    const d = closeDisposition(CLOSE_SUPERSEDED, "", 1);
    expect(d.message).toMatch(/superseded/i);
    expect(d.delayMs).toBe(SUPERSEDED_RETRY_MS);
  });

  it("any other close keeps the jittered fast-reconnect behaviour", () => {
    const d = closeDisposition(1005, "", 3, () => 1);
    expect(d.message).toBeNull();
    expect(d.delayMs).toBe(nextReconnectDelay(3, () => 1));
  });
});
