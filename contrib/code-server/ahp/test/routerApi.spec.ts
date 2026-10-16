import { describe, expect, it } from "vitest";
import { linker } from "../src/routerApi.js";

const ev = (n: number) => ({ type: "CUSTOM", n }) as never;
const frame = (prev: string, sum: string, n: number) => ({ kind: "event", event: ev(n), prevChecksum: prev, checksum: sum });

describe("linker", () => {
  it("drops replay frames and forwards the live events that follow history", () => {
    const link = linker("h2");
    expect(link({ kind: "event", event: ev(0) })).toBeUndefined(); // snapshot / unchecksummed replay
    expect(link(frame("h1", "h2", 2))).toBeUndefined(); // already in /history
    expect(link({ kind: "synced" })).toBeUndefined();
    expect(link(frame("h2", "h3", 3))).toEqual(ev(3));
    expect(link(frame("h3", "h4", 4))).toEqual(ev(4));
  });

  it("throws on a gap once linked, so the caller re-reads history", () => {
    const link = linker("h2");
    link(frame("h2", "h3", 3));
    expect(() => link(frame("h4", "h5", 5))).toThrow(/gap/);
  });

  it("links from an empty conversation", () => {
    const link = linker("empty");
    expect(link(frame("empty", "h1", 1))).toEqual(ev(1));
  });
});
