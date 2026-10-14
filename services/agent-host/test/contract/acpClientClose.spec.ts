/**
 * closeChild() awaits the goose child's exit. A model switch spawns a new goose right
 * after close(), and two processes sharing the per-conversation cwd could answer from
 * the old model, so close() must not resolve until the child is gone. Tested against a
 * controllable fake child so the SIGTERM, wait, SIGKILL sequence is deterministic.
 */

import { describe, it, expect, vi } from "vitest";

import { closeChild, type KillableChild } from "../../src/acp/client.js";

/** A fake child that records the signals sent and exits only when told to. */
function fakeChild(opts: { exitOnTerm?: boolean } = {}) {
  const signals: NodeJS.Signals[] = [];
  let exitCb: (() => void) | undefined;
  const child: KillableChild = {
    exitCode: null,
    signalCode: null,
    kill(signal?: NodeJS.Signals) {
      const s = signal ?? "SIGTERM";
      signals.push(s);
      // A well-behaved child exits on SIGTERM, a stubborn one only on SIGKILL.
      if ((s === "SIGTERM" && opts.exitOnTerm !== false) || s === "SIGKILL") {
        (child as { signalCode: NodeJS.Signals | null }).signalCode = s;
        queueMicrotask(() => exitCb?.());
      }
      return true;
    },
    once(_event, cb) {
      exitCb = cb;
    },
  };
  return { child, signals };
}

describe("closeChild()", () => {
  it("SIGTERMs the child and resolves once it exits", async () => {
    const { child, signals } = fakeChild();
    await closeChild(child);
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("does NOT resolve until the child actually exits", async () => {
    // A child that ignores both signals and never exits.
    const child: KillableChild = {
      exitCode: null,
      signalCode: null,
      kill: () => true,
      once: () => {},
    };
    let resolved = false;
    void closeChild(child, 10_000).then(() => (resolved = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it("SIGKILLs a child that ignores SIGTERM after the grace period (bounded)", async () => {
    vi.useFakeTimers();
    try {
      const { child, signals } = fakeChild({ exitOnTerm: false });
      let resolved = false;
      void closeChild(child, 10_000).then(() => (resolved = true));
      await Promise.resolve();
      expect(signals).toEqual(["SIGTERM"]);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      await Promise.resolve();
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op (resolves immediately) when the child already exited", async () => {
    const child: KillableChild = {
      exitCode: 0,
      signalCode: null,
      kill: () => { throw new Error("must not kill an already-dead child"); },
      once: () => { throw new Error("must not wait on an already-dead child"); },
    };
    await expect(closeChild(child)).resolves.toBeUndefined();
  });
});
