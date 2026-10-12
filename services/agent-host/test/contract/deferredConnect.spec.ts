/**
 * The deferred-connect in-flight dedupe: the sandbox exec client connects lazily on
 * first use, and a burst of concurrent first calls must share one in-flight connect
 * promise rather than each polling for pod readiness.
 */

import { describe, it, expect, vi } from "vitest";

import { createDeferredConnector } from "../../src/exec/deferredConnect.js";

describe("deferred connect — in-flight dedupe", () => {
  it("a burst of concurrent first uses connects exactly ONCE", async () => {
    let resolveConnect: (v: { tag: string }) => void;
    const connect = vi.fn(
      () => new Promise<{ tag: string }>((r) => (resolveConnect = r)),
    );
    const ensure = createDeferredConnector(connect);

    // Five concurrent first calls before the connect resolves.
    const calls = Promise.all([ensure(), ensure(), ensure(), ensure(), ensure()]);
    expect(connect).toHaveBeenCalledTimes(1);

    resolveConnect!({ tag: "client" });
    const results = await calls;
    expect(results.every((r) => r.tag === "client")).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reuses the resolved client on later calls (no reconnect)", async () => {
    const connect = vi.fn(async () => ({ tag: "client" }));
    const ensure = createDeferredConnector(connect);
    await ensure();
    await ensure();
    await ensure();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("a failed connect is NOT cached — the next call retries", async () => {
    let n = 0;
    const connect = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("pod not ready");
      return { tag: "client" };
    });
    const ensure = createDeferredConnector(connect);

    await expect(ensure()).rejects.toThrow("pod not ready");
    // The failure clears the in-flight promise so a retry reconnects.
    const ok = await ensure();
    expect(ok.tag).toBe("client");
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
