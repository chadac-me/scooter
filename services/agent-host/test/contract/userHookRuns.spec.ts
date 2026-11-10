/**
 * On-demand hook runs: a run is started, then read until it finishes, and a finished run
 * is forgotten after a while. The UI reads a hook's verdict, not the agent's view of it.
 */

import { describe, expect, it } from "vitest";

import type { HookOutcome } from "../../src/hooks/types.js";
import { createUserHookRuns, toUserOutcome } from "../../src/hooks/userRuns.js";

const outcome = (over: Partial<HookOutcome> = {}): HookOutcome => ({
  context: [],
  systemMessages: [],
  runs: [{ id: "g", event: "PreToolUse", decision: "allow", ms: 1 }],
  ...over,
});

describe("toUserOutcome", () => {
  it("passes when the hook ran and refused nothing", () => {
    expect(toUserOutcome(outcome())).toEqual({ ran: true, systemMessages: [] });
  });

  it("carries a refusal or a stop as the reason", () => {
    expect(toUserOutcome(outcome({ block: "tests failed" })).block).toBe("tests failed");
    expect(toUserOutcome(outcome({ stop: "ended" })).block).toBe("ended");
  });

  it("says it didn't run when it was skipped or nothing matched", () => {
    expect(toUserOutcome(outcome({ runs: [] })).ran).toBe(false);
    expect(toUserOutcome(outcome({ runs: [{ id: "g", event: "PreToolUse", decision: "skipped", ms: 0 }] })).ran).toBe(false);
  });

  it("reports a crash the hook didn't treat as a refusal", () => {
    const out = toUserOutcome(outcome({ runs: [{ id: "g", event: "PreToolUse", decision: "error", ms: 1, error: "timed out after 30s" }] }));
    expect(out).toMatchObject({ ran: true, error: "timed out after 30s" });
    expect(out.block).toBeUndefined();
  });
});

describe("createUserHookRuns", () => {
  it("is running until the hook settles, then done, per conversation", async () => {
    let settle!: (o: HookOutcome) => void;
    const runs = createUserHookRuns({ run: () => new Promise((ok) => (settle = ok)) });
    const id = runs.start("c1", "g", {});
    expect(runs.get("c1", id)?.state).toBe("running");
    expect(runs.get("c2", id)).toBeUndefined();
    settle(outcome({ block: "no" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(runs.get("c1", id)).toMatchObject({ state: "done", outcome: { block: "no" } });
  });

  it("forgets a finished run once it has been kept long enough", async () => {
    let t = 0;
    const runs = createUserHookRuns({ run: async () => outcome(), keepMs: 1000, now: () => t });
    const old = runs.start("c1", "g", {});
    await Promise.resolve();
    await Promise.resolve();
    t = 5000;
    // The next start sweeps.
    runs.start("c1", "g", {});
    expect(runs.get("c1", old)).toBeUndefined();
  });
});
