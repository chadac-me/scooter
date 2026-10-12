/**
 * Detecting an interrupted (dangling) run from the event-log tail: a run is
 * RUN_STARTED … RUN_FINISHED|RUN_ERROR, and a last RUN_STARTED with no later terminal
 * means the process died mid-run and the run is resumed on boot.
 */

import { describe, it, expect } from "vitest";

import { hasDanglingRun, danglingRunInfo, lastRunCompleted } from "../../src/session/danglingRun.js";
import type { AguiEvent } from "../../src/bridge.js";

const started = (r: string): AguiEvent => ({ type: "RUN_STARTED", threadId: "c", runId: r });
const finished = (r: string): AguiEvent => ({ type: "RUN_FINISHED", threadId: "c", runId: r });
const errored = (r: string): AguiEvent => ({ type: "RUN_ERROR", message: "boom", code: "x" } as AguiEvent);
const text = (): AguiEvent => ({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "hi" });

describe("hasDanglingRun", () => {
  it("true when the last run started but never finished", () => {
    expect(hasDanglingRun([started("r1"), finished("r1"), started("r2"), text()])).toBe(true);
  });

  it("false when the last run completed (finished)", () => {
    expect(hasDanglingRun([started("r1"), text(), finished("r1")])).toBe(false);
  });

  it("false when the last run errored (a real failure, not an interruption)", () => {
    expect(hasDanglingRun([started("r1"), text(), errored("r1")])).toBe(false);
  });

  it("false for an empty log or one with no run markers", () => {
    expect(hasDanglingRun([])).toBe(false);
    expect(hasDanglingRun([text()])).toBe(false);
  });

  it("true when a mid-conversation run dangles at the very end", () => {
    expect(hasDanglingRun([started("r1"), finished("r1"), started("r2"), text(), text()])).toBe(true);
  });
});

describe("lastRunCompleted (subagent completion signal)", () => {
  it("true when a run started and finished (the fast-run-between-ticks case)", () => {
    // A subagent run can start and finish within one watcher interval.
    expect(lastRunCompleted([started("r1"), text(), finished("r1")])).toBe(true);
  });

  it("true when the run errored (still a completed run to report)", () => {
    expect(lastRunCompleted([started("r1"), errored("r1")])).toBe(true);
  });

  it("false while a run is still in flight (dangling — not done yet)", () => {
    expect(lastRunCompleted([started("r1"), text()])).toBe(false);
    // A finished run followed by a new in-flight run is not complete yet.
    expect(lastRunCompleted([started("r1"), finished("r1"), started("r2"), text()])).toBe(false);
  });

  it("false when there are no runs yet (just spawned, hasn't started)", () => {
    expect(lastRunCompleted([])).toBe(false);
    expect(lastRunCompleted([text()])).toBe(false);
  });
});

// A dangling run is attributed to a host: the controller pushes revive on every Assign,
// so the predicate must tell a run this pod started from one a drained pod left behind.
const startedBy = (r: string, host?: string, gen?: number): AguiEvent =>
  ({ type: "RUN_STARTED", threadId: "c", runId: r, host, gen }) as AguiEvent;

describe("hasDanglingRun — run ownership", () => {
  const self = { host: "agent-host-0", gen: 5 };

  it("a run THIS pod started is in flight, NOT dangling", () => {
    expect(hasDanglingRun([startedBy("r1", "agent-host-0", 5)], self)).toBe(false);
  });

  it("a run ANOTHER pod started is stranded → dangling", () => {
    expect(hasDanglingRun([startedBy("r1", "agent-host-9", 5)], self)).toBe(true);
  });

  it("a run this pod started at an EARLIER generation is stranded", () => {
    // Reassigned away and back: same pod name, older assignment.
    expect(hasDanglingRun([startedBy("r1", "agent-host-0", 4)], self)).toBe(true);
  });

  it("an UNSTAMPED run (persisted before origin existed) stays dangling", () => {
    // An unknown origin reads as foreign.
    expect(hasDanglingRun([startedBy("r1")], self)).toBe(true);
  });

  it("with NO caller identity (single-replica) every dangling run still resumes", () => {
    expect(hasDanglingRun([startedBy("r1", "agent-host-0", 5)])).toBe(true);
  });

  it("a COMPLETED run is never dangling, whoever started it", () => {
    expect(hasDanglingRun([startedBy("r1", "agent-host-9", 4), finished("r1")], self)).toBe(false);
  });
});

describe("danglingRunInfo — persisted cancel intent", () => {
  // When a Stop races a scale-down, the CANCEL_REQUESTED marker is durable and the next owner reads the intent from the log.
  const cancelReq = (r: string): AguiEvent => ({ type: "CANCEL_REQUESTED", threadId: "c", runId: r });

  it("a dangling run whose tail carries its cancel marker reads cancelRequested @proves", () => {
    const info = danglingRunInfo([started("r1"), text(), cancelReq("r1")]);
    expect(info).toMatchObject({ runId: "r1", threadId: "c", cancelRequested: true });
  });

  it("a cancel marker for a PREVIOUS run does not taint the current dangling run @proves", () => {
    // r1 was stopped and finished properly; r2 dangles unstopped and must resume.
    const info = danglingRunInfo([started("r1"), cancelReq("r1"), finished("r1"), started("r2"), text()]);
    expect(info).toMatchObject({ runId: "r2", cancelRequested: false });
  });

  it("an uncancelled dangling run reads cancelRequested=false", () => {
    expect(danglingRunInfo([started("r1"), text()])).toMatchObject({ runId: "r1", cancelRequested: false });
  });
});

describe("OwnershipTracker.onGained — the settlement trigger", () => {
  it("fires on a reassignment TO this pod, not on same-owner echoes @proves", async () => {
    const { OwnershipTracker } = await import("../../src/session/ownershipGuard.js");
    const t = new OwnershipTracker("me");
    const gained: Array<[string, number]> = [];
    t.onGained = (id, gen) => gained.push([id, gen]);

    t.observe("c1", { hostPod: "other", generation: 1 }); // someone else's
    t.observe("c1", { hostPod: "me", generation: 2 });    // moved to us: fires
    t.observe("c1", { hostPod: "me", generation: 2 });    // echo: silent
    t.observe("c2", { hostPod: "me", generation: 1 });    // boot-list reveal: fires
    t.observe("c1", { hostPod: "other", generation: 3 }); // moved away: silent
    t.observe("c1", { hostPod: "me", generation: 4 });    // back again: fires

    expect(gained).toEqual([["c1", 2], ["c2", 1], ["c1", 4]]);
  });
});
