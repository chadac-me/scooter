import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  budgetKnob,
  compareToBaseline,
  patternToRegExp,
  renderMarkdown,
  repetitionsFor,
  summarize,
  summarizeHistory,
} from "./flake-focus-report.mjs";

/**
 * A minimal Playwright JSON report shaped like the real thing: --repeat-each=N
 * emits N sibling `specs` entries with the same title, so one status per spec
 * entry here, e.g. report([["test/e2e/x.spec.ts", [["a test", ["passed", "failed"]]]]]).
 */
const report = (files) => ({
  suites: files.map(([file, specs]) => ({
    title: file,
    file,
    specs: specs.flatMap(([title, statuses]) =>
      statuses.map((s) => ({
        title,
        file,
        tests: [
          {
            results: [
              { status: s, ...(s === "passed" ? {} : { error: { message: "expected 3, got 2" } }) },
            ],
          },
        ],
      })),
    ),
    suites: [],
  })),
});

const targeted = (statuses) =>
  report([["test/e2e/queue-durability.spec.ts", [["THREE messages sent mid-run", statuses]]]]);

describe("summarize", () => {
  it("reports a clean targeted run as fixed, counting every repetition", () => {
    const s = summarize(targeted(Array(20).fill("passed")), "THREE messages sent mid-run");
    expect(s.verdict).toBe("fixed");
    expect(s.runs).toBe(20);
    expect(s.failed).toBe(0);
    expect(s.matched).toHaveLength(1);
    expect(s.matched[0].fullTitle).toContain("THREE messages sent mid-run");
  });

  it("reports a single failed repetition as still reproducing", () => {
    const s = summarize(
      targeted([...Array(17).fill("passed"), "failed", ...Array(2).fill("passed")]),
      "THREE messages sent mid-run",
    );
    expect(s.verdict).toBe("reproduced");
    expect(s.failed).toBe(1);
    expect(s.runs).toBe(20);
  });

  it("counts timedOut and interrupted as failures, not as passes", () => {
    const s = summarize(targeted(["passed", "timedOut", "interrupted"]), "mid-run");
    expect(s.failed).toBe(2);
    expect(s.verdict).toBe("reproduced");
  });

  // In a contention run playwright exits 0 having never executed the flaky test.
  it("reports not-run when the pattern matches nothing that executed", () => {
    const s = summarize(
      report([["test/e2e/sessions.spec.ts", [["renames a session", ["passed", "passed"]]]]]),
      "THREE messages sent mid-run",
    );
    expect(s.verdict).toBe("not-run");
    expect(s.runs).toBe(0);
    expect(s.executedSpecs).toBe(1);
  });

  it("reports not-run when the matching test existed but was skipped", () => {
    const s = summarize(targeted(["skipped", "skipped"]), "mid-run");
    expect(s.verdict).toBe("not-run");
    expect(s.matchedButSkipped).toBe(1);
  });

  it("separates other specs' failures from the targeted test's", () => {
    const s = summarize(
      report([
        ["test/e2e/queue-durability.spec.ts", [["THREE messages sent mid-run", ["passed", "passed"]]]],
        ["test/e2e/sessions.spec.ts", [["renames a session", ["failed"]]]],
      ]),
      "THREE messages sent mid-run",
    );
    expect(s.verdict).toBe("fixed");
    expect(s.others).toHaveLength(1);
    expect(s.others[0].fullTitle).toContain("renames a session");
  });

  it("matches the pattern against the full title path, like playwright -g", () => {
    const s = summarize(
      {
        suites: [
          {
            title: "test/e2e/sessions.spec.ts",
            file: "test/e2e/sessions.spec.ts",
            specs: [],
            suites: [
              {
                title: "sessions",
                file: "test/e2e/sessions.spec.ts",
                specs: [{ title: "renames a session", tests: [{ results: [{ status: "passed" }] }] }],
                suites: [],
              },
            ],
          },
        ],
      },
      "sessions › renames",
    );
    expect(s.verdict).toBe("fixed");
  });
});

describe("patternToRegExp", () => {
  it("matches case-insensitively, as playwright's -g does", () => {
    expect(patternToRegExp("three MESSAGES").test("THREE messages sent")).toBe(true);
  });

  it("honours regex syntax and /…/flags form", () => {
    expect(patternToRegExp("sent (mid|post)-run").test("THREE messages sent mid-run")).toBe(true);
    expect(patternToRegExp("/^queue/").test("queue survives")).toBe(true);
  });

  // A regex typo must not read as "the test does not exist".
  it("falls back to a literal match on an invalid regex", () => {
    expect(patternToRegExp("a (b").test("a (b")).toBe(true);
  });
});

describe("renderMarkdown", () => {
  const md = (statuses, opts) =>
    renderMarkdown(summarize(targeted(statuses), "THREE messages sent mid-run"), opts);

  // The body is a section of the shared comment, and comment-sections.mjs owns the
  // markers.
  it("names its target in the heading and carries no hidden marker", () => {
    expect(md(["passed"], { target: "full" })).toContain("flake focus (full)");
    expect(md(["passed"], { target: "fast" })).not.toContain("<!--");
  });

  it("names the specific test and the repetition count on green", () => {
    const body = md(Array(20).fill("passed"), { target: "fast" });
    expect(body).toContain("✅");
    expect(body).toContain("no reproduction in 20 repetitions");
    expect(body).toContain("THREE messages sent mid-run");
    expect(body).toContain("| 20 | 20 | 0 |");
  });

  it("nudges toward the full target only when asked, and only on green", () => {
    expect(md(["passed"], { target: "fast", suggestFull: true })).toContain("e2e-full-flake-check");
    expect(md(["passed"], { target: "fast" })).not.toContain("e2e-full-flake-check");
    expect(md(["failed"], { target: "fast", suggestFull: true })).not.toContain("e2e-full-flake-check");
  });

  it("shows the failure output when the flake still reproduces", () => {
    const body = md(["passed", "failed"], { target: "fast" });
    expect(body).toContain("❌");
    expect(body).toContain("STILL reproduces");
    expect(body).toContain("failed **1 of 2 repetitions**");
    expect(body).toContain("expected 3, got 2");
  });

  it("explains, on not-run, that the check proved nothing", () => {
    const body = renderMarkdown(
      summarize(report([["test/e2e/sessions.spec.ts", [["renames a session", ["passed"]]]]]), "no such test"),
      { target: "fast", mode: "contention", specs: "test/e2e/sessions.spec.ts" },
    );
    expect(body).toContain("⚠️");
    expect(body).toContain("never ran");
    expect(body).toContain("proves nothing");
    expect(body).toContain("test/e2e/sessions.spec.ts");
  });
});

describe("compareToBaseline", () => {
  const pr = (statuses) => summarize(targeted(statuses), "THREE messages sent mid-run");
  const base = (statuses) => summarize(targeted(statuses), "THREE messages sent mid-run");

  it("calls it strong when the flake fires on the base and not on the PR", () => {
    const c = compareToBaseline(pr(Array(20).fill("passed")), base([...Array(14).fill("passed"), ...Array(6).fill("failed")]));
    expect(c.kind).toBe("strong");
    expect(c.baseFailed).toBe(6);
    expect(c.baseRate).toBeCloseTo(0.3);
    // P(20 clean runs | 30% failure rate) — the bound the comment quotes.
    expect(c.pAllCleanAtBaseRate).toBeLessThan(0.001);
  });

  // A clean PR run that could never have detected the flake must not read as "fixed".
  it("calls it inconclusive when the base run is clean too", () => {
    const c = compareToBaseline(pr(Array(20).fill("passed")), base(Array(20).fill("passed")));
    expect(c.kind).toBe("inconclusive");
  });

  it("calls it worse when the PR fails more often than the base", () => {
    const c = compareToBaseline(pr(["failed", "failed", "passed"]), base(["failed", "passed", "passed"]));
    expect(c.kind).toBe("worse");
  });

  it("reports no control when the base ran nothing (renamed test, missing report)", () => {
    expect(compareToBaseline(pr(["passed"]), null).kind).toBe("none");
    expect(compareToBaseline(pr(["passed"]), { runs: 0, failed: 0, matched: [] }).kind).toBe("none");
  });
});

describe("renderMarkdown with a control run", () => {
  const md = (prStatuses, baseStatuses, opts = {}) =>
    renderMarkdown(summarize(targeted(prStatuses), "THREE messages sent mid-run"), {
      target: "fast",
      baseline: baseStatuses && summarize(targeted(baseStatuses), "THREE messages sent mid-run"),
      baselineRef: "main@abc1234",
      ...opts,
    });

  it("leads with the fires-on-base/clean-here headline and quotes both rates", () => {
    const body = md(Array(20).fill("passed"), [...Array(14).fill("passed"), ...Array(6).fill("failed")]);
    expect(body).toContain("✅");
    expect(body).toContain("fires on the base, not here");
    expect(body).toContain("**6/20** on the base");
    expect(body).toContain("| base (`main@abc1234`) | 20 | 6 |");
    expect(body).toContain("| this PR | 20 | 0 |");
  });

  // A clean run with a clean control must not read as a ✅ fix.
  it("downgrades a clean run to ⚠️ inconclusive when the control was clean", () => {
    const body = md(Array(20).fill("passed"), Array(20).fill("passed"));
    expect(body).toContain("⚠️");
    expect(body).toContain("control did not reproduce either");
    expect(body).toContain("no power");
    expect(body).not.toContain("✅");
  });

  // Both "no usable control" branches are asserted in "why there is no control" below.
  it("reports the absence of a control rather than omitting it silently", () => {
    expect(md(Array(5).fill("passed"), [])).toContain("Control — none");
  });

  it("omits the control section entirely when none was attempted", () => {
    const body = md(Array(5).fill("passed"), null);
    expect(body).not.toContain("Control");
  });

  // A powerless full run is already under the label the fast nudge would name, so it
  // is pointed at the knob it does still have — and at the key that sets it, since a
  // budget nobody can raise without editing CI is not a remedy.
  it("points a powerless full run at the budget, not at its own label", () => {
    const body = md(Array(5).fill("passed"), Array(5).fill("passed"), { target: "full" });
    expect(body).toContain("no power");
    expect(body).toContain("`flake-full-repeat: <n>`");
    expect(body).not.toContain("use the `e2e-full-flake-check` label");
  });

  it("still offers the full target to a powerless fast run", () => {
    const body = md(Array(5).fill("passed"), Array(5).fill("passed"), { target: "fast" });
    expect(body).toContain("use the `e2e-full-flake-check` label");
    expect(body).toContain("`flake-repeat: <n>`");
    // The fast job cannot raise the full job's budget, so it must not suggest it.
    expect(body).not.toContain("flake-full-repeat");
  });

  // The trap behind this whole knob: naming `flake-specs:` buys the smaller
  // contention budget, so a PR that wanted more power silently got less.
  it("tells a powerless contention run that targeted mode has the bigger budget", () => {
    const body = md(Array(3).fill("passed"), Array(3).fill("passed"), {
      target: "full",
      mode: "contention",
      specs: "test/e2e/stop-run.spec.ts",
    });
    expect(body).toContain("`flake-mode: targeted`");
  });

  it("says nothing about `flake-mode:` when the run was already targeted", () => {
    const body = md(Array(5).fill("passed"), Array(5).fill("passed"), { target: "full" });
    expect(body).not.toContain("flake-mode");
  });
});

// 2/20 on the base leaves ~12% odds of a clean run by luck, which must read as weak.
describe("control strength", () => {
  const clean20 = summarize(targeted(Array(20).fill("passed")), "THREE messages sent mid-run");
  const baseWith = (failures) =>
    summarize(
      targeted([...Array(20 - failures).fill("passed"), ...Array(failures).fill("failed")]),
      "THREE messages sent mid-run",
    );

  it("calls a 2/20 base loose and a 6/20 base tight", () => {
    expect(compareToBaseline(clean20, baseWith(2)).strength).toBe("loose");
    expect(compareToBaseline(clean20, baseWith(6)).strength).toBe("tight");
  });

  it("does not claim a behaviour change on a loose control", () => {
    const body = renderMarkdown(clean20, { baseline: baseWith(2), baselineRef: "main@abc" });
    expect(body).toContain("control is weak");
    expect(body).toContain("luck explains this result almost as well");
    expect(body).not.toContain("real change in behaviour");
  });

  it("does claim it on a tight one", () => {
    const body = renderMarkdown(clean20, { baseline: baseWith(6), baselineRef: "main@abc" });
    expect(body).toContain("fires on the base, not here");
    expect(body).toContain("real change in behaviour");
  });
});

// "Raise the budget" with no number is what leaves a PR guessing, so the report
// sizes it: how many repetitions make a clean run mean something at a known rate.
describe("sizing the repetition budget", () => {
  const P = "THREE messages sent mid-run";
  const clean = (n) => summarize(targeted(Array(n).fill("passed")), P);
  const baseWith = (failures, total) =>
    summarize(targeted([...Array(total - failures).fill("passed"), ...Array(failures).fill("failed")]), P);

  it("needs ~14 repetitions at a 1-in-5 rate and ~59 at 1-in-20", () => {
    expect(repetitionsFor(0.2)).toBe(14);
    expect(repetitionsFor(0.05)).toBe(59);
    // A rate of 0 gives no number at all — nothing observed, nothing to size from.
    expect(repetitionsFor(0)).toBe(null);
  });

  it("names the number and the key on a weak control", () => {
    const body = renderMarkdown(clean(5), { target: "full", baseline: baseWith(1, 5), baselineRef: "main@abc" });
    expect(body).toContain("control is weak");
    expect(body).toContain("`flake-full-repeat: 14`");
  });

  // The full target caps at 20 repetitions, so a rare flake must be argued from the
  // failure's mechanism rather than chased with a budget that is not available.
  it("admits when the required budget is past the cap instead of suggesting it", () => {
    const body = renderMarkdown(clean(5), { target: "full", baseline: baseWith(1, 40), baselineRef: "main@abc" });
    expect(body).toContain("past this target's cap of 20");
    expect(body).not.toContain("flake-full-repeat: 1");
  });

  // The caps and keys this report quotes are enforced by the parser, in another
  // language, in another directory — so assert they are the same ones.
  it("quotes the keys and caps the PR-description parser actually enforces", () => {
    const sh = readFileSync(new URL("../.github/scripts/flake-focus-pattern.sh", import.meta.url), "utf8");
    for (const target of ["fast", "full"]) {
      const { key, cap } = budgetKnob(target);
      expect(sh).toContain(`repeat_key='${key}'`);
      expect(sh).toContain(`repeat_cap=${cap}`);
    }
  });

  // A clean control has no rate of its own, so a powerless run borrows the nightly's.
  it("sizes a powerless run from the nightly rate when the control gives none", () => {
    const sweep = (failures) =>
      targeted([...Array(5 - failures).fill("passed"), ...Array(failures).fill("failed")]);
    const body = renderMarkdown(clean(5), {
      target: "full",
      baseline: clean(5),
      baselineRef: "main@abc",
      history: summarizeHistory([sweep(1), sweep(1)], P),
    });
    expect(body).toContain("no power");
    expect(body).toContain("`flake-full-repeat: 14`");
  });
});

// A dead control run and an unmatched pattern are different problems.
describe("why there is no control", () => {
  const clean = summarize(targeted(["passed", "passed"]), "THREE messages sent mid-run");
  const emptyReport = summarize({ suites: [] }, "THREE messages sent mid-run");
  const ranOtherTests = summarize(
    report([["test/e2e/sessions.spec.ts", [["renames a session", ["passed"]]]]]),
    "THREE messages sent mid-run",
  );

  it("distinguishes a dead control run from a pattern that matched nothing", () => {
    expect(compareToBaseline(clean, emptyReport).noneReason).toBe("no-tests");
    expect(compareToBaseline(clean, ranOtherTests).noneReason).toBe("no-match");
    expect(compareToBaseline(clean, null).noneReason).toBe("not-attempted");
  });

  it("says infrastructure failure, not 'renamed', when the control ran nothing", () => {
    const body = renderMarkdown(clean, { baseline: emptyReport, baselineRef: "main@abc" });
    expect(body).toContain("executed **no tests at all**");
    expect(body).toContain("infrastructure failure");
    expect(body).not.toContain("renamed");
  });

  it("still blames the pattern when the control ran other tests", () => {
    const body = renderMarkdown(clean, { baseline: ranOtherTests, baselineRef: "main@abc" });
    expect(body).toContain("renamed in this PR?");
  });
});

describe("the nightly window", () => {
  const P = "THREE messages sent mid-run";
  // One nightly = one run of the whole suite, so one status per report.
  const night = (status) => targeted([status]);
  // A lost shard omits its specs from the merge entirely — not a pass.
  const lostShard = report([["test/e2e/other.spec.ts", [["unrelated", ["passed"]]]]]);

  it("counts only the runs that executed the spec", () => {
    const h = summarizeHistory(
      [night("failed"), lostShard, night("passed"), night("failed")],
      P,
    );
    expect(h.ran).toBe(3);
    expect(h.failed).toBe(2);
    expect(h.runs.map((r) => (!r.ran ? "-" : r.failed ? "F" : "."))).toEqual(["F", "-", ".", "F"]);
  });

  it("does not let a lost shard read as a green run", () => {
    expect(summarizeHistory([lostShard, lostShard], P)).toMatchObject({ ran: 0, failed: 0 });
  });

  // A clean control while main still fails the spec is not a fix.
  it("refuses to read a clean run as a fix when main is still failing it", () => {
    const body = renderMarkdown(summarize(targeted(Array(5).fill("passed")), P), {
      pattern: P,
      target: "full",
      // inconclusive: the control ran but the flake fired on neither side.
      baseline: summarize(targeted(Array(5).fill("passed")), P),
      history: summarizeHistory([night("failed"), night("failed"), night("passed")], P),
    });
    expect(body).toContain("2/3 nightly runs");
    expect(body).toContain("the control did not reproduce it");
    expect(body).toContain("not evidence of a fix".slice(0, 10));
  });

  // The nightly is a sweep, so a night carries a rate and "F" would throw away the
  // difference between 1-in-5 and always-red.
  it("shows each sweep night's rate, not just whether it fired", () => {
    const sweepNight = (failures) =>
      targeted([...Array(5 - failures).fill("passed"), ...Array(failures).fill("failed")]);
    const h = summarizeHistory([sweepNight(0), sweepNight(2)], P);
    expect(h.runs.map((r) => [r.failedRuns, r.totalRuns])).toEqual([
      [0, 5],
      [2, 5],
    ]);
    const body = renderMarkdown(summarize(targeted(Array(5).fill("passed")), P), {
      pattern: P,
      target: "full",
      history: h,
    });
    expect(body).toContain("`0/5` **2/5**");
    expect(body).not.toContain("**F**");
  });

  it("warns when the window shows nothing left to fix", () => {
    const body = renderMarkdown(summarize(targeted(Array(5).fill("passed")), P), {
      pattern: P,
      target: "full",
      history: summarizeHistory([night("passed"), night("passed")], P),
    });
    expect(body).toContain("no live reproduction");
  });

  it("stays silent when no window was downloaded", () => {
    const body = renderMarkdown(summarize(targeted(Array(5).fill("passed")), P), { pattern: P });
    expect(body).not.toContain("nightly run");
  });
});
