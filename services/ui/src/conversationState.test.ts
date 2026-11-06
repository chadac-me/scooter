// Shared state channels and the topic reader built on them.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { createStateChannels, watchTopic, type StateFrame, type TopicOptions } from "./conversationState.js";

/** Each call is one connection whose frames the test writes. */
function scriptedFetch() {
  const conns: { push(f: StateFrame): void; end(): void }[] = [];
  const impl = (async () => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
    const enc = new TextEncoder();
    conns.push({
      push: (f) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`)),
      end: () => ctl.close(),
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { conns, impl, channels: createStateChannels({ fetchImpl: impl }) };
}

/** Follow a topic, recording its values and fallback poll starts and stops. */
function follow<T>(channels: ReturnType<typeof createStateChannels>, topic: string, opts: TopicOptions<T> = {}) {
  const values: T[] = [];
  const polls: string[] = [];
  const stop = watchTopic<T>(
    channels,
    "/conversations/1/state/events",
    topic,
    () => opts,
    (v) => void values.push(v),
    () => {
      polls.push("start");
      return () => void polls.push("stop");
    },
  );
  return { values, polls, stop };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("state channels", () => {
  it("shares one connection between readers of a conversation and closes it with the last", async () => {
    const f = scriptedFetch();
    const a = follow(f.channels, "sandbox");
    const b = follow(f.channels, "contrib:shares");
    await settle();
    expect(f.conns).toHaveLength(1);
    a.stop();
    expect(f.channels.size()).toBe(1);
    b.stop();
    expect(f.channels.size()).toBe(0);
  });

  it("delivers a pushed value to its topic only, and gives a late reader the kept value", async () => {
    const f = scriptedFetch();
    const sandbox = follow<{ ready: boolean }>(f.channels, "sandbox");
    const shares = follow(f.channels, "contrib:shares");
    await settle();
    f.conns[0].push({ kind: "synced" });
    f.conns[0].push({ kind: "topic", topic: "sandbox", data: { ready: true } });
    await settle();
    expect(sandbox.values).toEqual([{ ready: true }]);
    expect(shares.values).toEqual([]);

    const late = follow<{ ready: boolean }>(f.channels, "sandbox");
    expect(late.values).toEqual([{ ready: true }]);
    for (const r of [sandbox, shares, late]) r.stop();
  });

  it("re-runs the loader on an invalidation", async () => {
    const f = scriptedFetch();
    let n = 0;
    const r = follow<number>(f.channels, "contrib:shares", { load: async () => ++n });
    await settle();
    const before = n;
    f.conns[0].push({ kind: "topic", topic: "contrib:shares" });
    await settle();
    expect(n).toBe(before + 1);
    expect(r.values.at(-1)).toBe(n);
    r.stop();
  });

  it("does not let a slow load overwrite a newer pushed value", async () => {
    const f = scriptedFetch();
    const pending: ((v: string) => void)[] = [];
    const r = follow<string>(f.channels, "contrib:x", { load: () => new Promise<string>((res) => pending.push(res)) });
    await settle();
    f.conns[0].push({ kind: "topic", topic: "contrib:x", data: "pushed" });
    await settle();
    for (const release of pending) release("stale");
    await settle();
    expect(r.values).toEqual(["pushed"]);
    r.stop();
  });

  it("polls while the stream is down, and reloads when it comes back", async () => {
    const f = scriptedFetch();
    let n = 0;
    const r = follow<number>(f.channels, "contrib:shares", { load: async () => ++n, fallbackPollMs: 10_000 });
    await settle();
    // Before connecting it reads once and arms the poll; the connect disarms it.
    expect(r.polls).toEqual(["start", "stop"]);
    const before = n;

    f.conns[0].end();
    await settle();
    expect(r.polls.at(-1)).toBe("start");

    await vi.advanceTimersByTimeAsync(500);
    expect(f.conns).toHaveLength(2);
    expect(r.polls.at(-1)).toBe("stop");
    expect(n, "frames sent while down are gone, so a reconnect reloads").toBeGreaterThan(before);
    r.stop();
  });
});
