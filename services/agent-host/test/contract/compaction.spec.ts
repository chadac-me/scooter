/**
 * Manual conversation compaction: split the log by runs, summarize the older turns,
 * append a COMPACTION_MARKER, and reseed a revived session's history from it.
 */

import { describe, it, expect, vi } from "vitest";

import {
  compactConversation,
  historyAfterCompaction,
  keepRunsFor,
  COMPACT_MIN_TOTAL_RUNS,
  type CompactionDeps,
} from "../../src/session/compaction.js";
import type { AguiEvent } from "../../src/bridge.js";

/** A log of `n` runs, each a user "u<i>" and an assistant "a<i>" message. */
function log(n: number): AguiEvent[] {
  const evs: AguiEvent[] = [];
  for (let i = 1; i <= n; i++) {
    evs.push({ type: "RUN_STARTED", threadId: "c1", runId: `r${i}`, ts: i * 1000 });
    evs.push({ type: "TEXT_MESSAGE_START", messageId: `u${i}`, role: "user", ts: i * 1000 + 1 });
    evs.push({ type: "TEXT_MESSAGE_CONTENT", messageId: `u${i}`, delta: `question ${i}`, ts: i * 1000 + 2 });
    evs.push({ type: "TEXT_MESSAGE_END", messageId: `u${i}`, ts: i * 1000 + 3 });
    evs.push({ type: "TEXT_MESSAGE_START", messageId: `a${i}`, role: "assistant", ts: i * 1000 + 4 });
    evs.push({ type: "TEXT_MESSAGE_CONTENT", messageId: `a${i}`, delta: `answer ${i}`, ts: i * 1000 + 5 });
    evs.push({ type: "TEXT_MESSAGE_END", messageId: `a${i}`, ts: i * 1000 + 6 });
    evs.push({ type: "RUN_FINISHED", threadId: "c1", runId: `r${i}`, ts: i * 1000 + 7 });
  }
  return evs;
}

function fakeStore(events: AguiEvent[]) {
  const appended: AguiEvent[] = [];
  return {
    appended,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *readEvents(): any { for (const e of events) yield e; },
    appendEvent: vi.fn(async (_id: string, e: AguiEvent) => { appended.push(e); }),
  } as never;
}

const deps = (summary = "RECAP"): CompactionDeps => ({
  model: "m", oauthToken: "t", summarize: async () => summary,
});

describe("keepRunsFor", () => {
  it("keeps ~30% of runs, at least the minimum", () => {
    expect(keepRunsFor(20)).toBe(6);
    expect(keepRunsFor(4)).toBe(2);
    expect(keepRunsFor(3)).toBe(2);
  });
});

describe("compactConversation", () => {
  it("summarizes older turns + appends a COMPACTION_MARKER", async () => {
    const store = fakeStore(log(10));
    const res = await compactConversation(store, "c1", deps("the recap"));
    expect(res).toMatchObject({ keptRuns: 3, summarizedTurns: expect.any(Number) });
    const marker = store.appended.find((e: AguiEvent) => e.type === "COMPACTION_MARKER");
    expect(marker).toMatchObject({ type: "COMPACTION_MARKER", summary: "the recap" });
  });

  it("is a no-op (null) for a short conversation (nothing to gain)", async () => {
    const store = fakeStore(log(COMPACT_MIN_TOTAL_RUNS - 1));
    expect(await compactConversation(store, "c1", deps())).toBeNull();
    expect(store.appended).toEqual([]);
  });

  it("propagates a summarizer failure (caller leaves the conversation unchanged)", async () => {
    const store = fakeStore(log(10));
    const failing: CompactionDeps = { model: "m", oauthToken: "t", summarize: async () => { throw new Error("LLM down"); } };
    await expect(compactConversation(store, "c1", failing)).rejects.toThrow(/LLM down/);
    expect(store.appended).toEqual([]);
  });
});

describe("historyAfterCompaction", () => {
  it("with no marker, returns the log unchanged", () => {
    const evs = log(3);
    expect(historyAfterCompaction(evs)).toBe(evs);
  });

  it("reseeds from [summary recap turn + events after the latest marker]", () => {
    const recent = log(2);
    const evs: AguiEvent[] = [
      ...log(1),
      { type: "COMPACTION_MARKER", summary: "EARLIER RECAP", summarizedTurns: 1, keptRuns: 2, ts: 5000 },
      ...recent,
    ];
    const out = historyAfterCompaction(evs);
    // The first turn is the recap, then the recent verbatim events.
    const firstContent = out.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as Extract<AguiEvent, { type: "TEXT_MESSAGE_CONTENT" }>;
    expect(firstContent.delta).toContain("EARLIER RECAP");
    // The pre-marker events are gone and the recent ones remain.
    expect(out.filter((e) => e.type === "RUN_STARTED")).toHaveLength(2);
    expect(out.some((e) => e.type === "COMPACTION_MARKER")).toBe(false);
  });
});
