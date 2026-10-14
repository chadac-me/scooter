/**
 * Graceful shutdown wiring (installShutdownHandlers): on SIGTERM the pod drains and
 * closes cleanly so clients reconnect, bounded so a stuck drain cannot outlive the
 * pod's terminationGracePeriod.
 */
import { describe, it, expect, vi } from "vitest";

import { installShutdownHandlers } from "../../src/index.js";

/** A fake process that captures signal handlers and exit calls. */
function fakeProc() {
  const handlers: Record<string, (sig: string) => void> = {};
  const exits: number[] = [];
  const proc = {
    on(sig: string, fn: (s: string) => void) { handlers[sig] = fn; return proc; },
    exit(code?: number) { exits.push(code ?? 0); },
    fire: (sig: string) => handlers[sig]?.(sig),
    handlers,
    exits,
  };
  return proc;
}

describe("installShutdownHandlers", () => {
  it("registers SIGTERM and SIGINT", () => {
    const proc = fakeProc();
    installShutdownHandlers(async () => {}, { proc: proc as never });
    expect(Object.keys(proc.handlers).sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("drains then exits 0 on SIGTERM", async () => {
    const proc = fakeProc();
    const drained = vi.fn(async () => {});
    installShutdownHandlers(drained, { proc: proc as never });
    proc.fire("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toHaveBeenCalledTimes(1);
    expect(proc.exits).toEqual([0]);
  });

  it("ignores a repeat signal mid-drain (drains once)", async () => {
    const proc = fakeProc();
    let resolve!: () => void;
    const drained = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    installShutdownHandlers(drained, { proc: proc as never });
    proc.fire("SIGTERM");
    proc.fire("SIGTERM");
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it("force-exits if the drain exceeds the timeout (never outlives the grace period)", () => {
    const proc = fakeProc();
    let fireTimeout!: () => void;
    const fakeSetTimeout = ((fn: () => void) => { fireTimeout = fn; return { unref() {} }; }) as unknown as typeof setTimeout;
    installShutdownHandlers(() => new Promise<void>(() => {}), {
      proc: proc as never,
      timeoutMs: 10,
      setTimeoutFn: fakeSetTimeout,
    });
    proc.fire("SIGTERM");
    fireTimeout();
    expect(proc.exits).toEqual([0]);
  });
});
