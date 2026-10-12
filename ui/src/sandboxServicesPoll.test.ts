/**
 * The sandbox status hook polls every 4s and loadWebServices returns a freshly
 * parsed array each time, so an unchanged poll must keep the previous array or
 * every consumer re-renders on every tick.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sameServices } from "./SandboxPanel.js";
import type { WebService } from "./client.js";

const svc = (o: Partial<WebService> = {}): WebService => ({
  name: "marimo", displayName: "Marimo", url: "/x/marimo", running: true, ...o,
});

describe("sameServices", () => {
  it("treats a re-parsed but identical payload as unchanged", () => {
    expect(sameServices([svc(), svc({ name: "xterm" })],
                        [svc(), svc({ name: "xterm" })])).toBe(true);
  });

  it("detects a service starting or stopping", () => {
    expect(sameServices([svc({ running: true })], [svc({ running: false })])).toBe(false);
  });

  it("detects added, removed, renamed, and re-pathed services", () => {
    expect(sameServices([svc()], [svc(), svc({ name: "xterm" })])).toBe(false);
    expect(sameServices([svc(), svc({ name: "xterm" })], [svc()])).toBe(false);
    expect(sameServices([svc()], [svc({ displayName: "Marimo 2" })])).toBe(false);
    expect(sameServices([svc()], [svc({ url: "/x/other" })])).toBe(false);
  });

  it("handles the empty list both ways", () => {
    expect(sameServices([], [])).toBe(true);
    expect(sameServices([], [svc()])).toBe(false);
  });

  it("keeps the previous reference when unchanged, swaps when changed", () => {
    // The property that matters is what the state setter does.
    const prev = [svc()];
    const set = (p: WebService[], next: WebService[]) => (sameServices(p, next) ? p : next);
    expect(set(prev, [svc()])).toBe(prev);
    const changed = [svc({ running: false })];
    expect(set(prev, changed)).toBe(changed);
  });
});

describe("the services poll", () => {
  it("routes its state update through sameServices", () => {
    // A correct sameServices is worthless if the poll does not call it.
    const src = readFileSync(new URL("./SandboxPanel.tsx", import.meta.url), "utf8");
    const setter = src.match(/if \(svcs\) setServices\(([^\n]*)\);/)?.[1];
    expect(setter, "services poll setter not found").toBeTruthy();
    expect(setter).toContain("sameServices");
    expect(setter).toMatch(/prev/);
  });
});
