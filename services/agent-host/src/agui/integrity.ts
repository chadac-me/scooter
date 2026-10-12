/**
 * Rolling integrity checksum for a conversation's AG-UI event log: a hash chain
 * checksum_n = sha256(checksum_{n-1} || canonical(event_n)) from a fixed seed, where
 * each event carries the checksum through itself plus the previous one. A client
 * whose held checksum does not match an event's `prevChecksum` has a gap and
 * re-fetches history. The hash input is canonical JSON (stable key order) so server
 * and client compute identical values.
 */

import { createHash } from "node:crypto";

import type { AguiEvent } from "../bridge.js";

/** Seed checksum for an empty log. */
export const EMPTY_CHECKSUM = "0".repeat(64);

/** Canonical JSON for hashing, with keys sorted; AG-UI events are flat records, so a shallow sort suffices. */
export function canonicalize(event: AguiEvent): string {
  const obj = event as unknown as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

/** Fold one event into the chain: sha256(prev || canonical(event)). */
export function chainNext(prev: string, event: AguiEvent): string {
  return createHash("sha256").update(prev).update(canonicalize(event)).digest("hex");
}

/** Compute the checksum of an in-order event sequence from the seed. */
export function chainAll(events: Iterable<AguiEvent>, seed = EMPTY_CHECKSUM): string {
  let acc = seed;
  for (const e of events) acc = chainNext(acc, e);
  return acc;
}

/** A stateful folder tracking the running checksum as events are appended. */
export interface ChecksumChain {
  /** Checksum through the last folded event (EMPTY_CHECKSUM if none). */
  readonly current: string;
  /** Fold `event`, returning the checksum before and after. */
  push(event: AguiEvent): { prev: string; next: string };
  /** Reset to a known checksum, e.g. after a resync. */
  reset(to: string): void;
}

export function createChecksumChain(seed = EMPTY_CHECKSUM): ChecksumChain {
  let current = seed;
  return {
    get current() {
      return current;
    },
    push(event) {
      const prev = current;
      current = chainNext(prev, event);
      return { prev, next: current };
    },
    reset(to) {
      current = to;
    },
  };
}
