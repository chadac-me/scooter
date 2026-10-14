import { describe, expect, it } from "vitest";

import { compare, renderMarkdown } from "./e2e-full-compare.mjs";

/** Build a minimal Playwright JSON report: `specs` is [title, ok] pairs. */
function report(specs, meta) {
  return {
    meta,
    suites: [
      {
        title: "",
        file: "spec.ts",
        suites: specs.map(([title, ok]) => ({
          title: "group",
          file: "spec.ts",
          specs: [
            {
              title,
              file: "spec.ts",
              tests: [
                {
                  results: [{ status: ok ? "passed" : "failed", duration: 1 }],
                },
              ],
            },
          ],
        })),
      },
    ],
  };
}

const title = (t) => `group › ${t}`;

describe("compare", () => {
  it("splits failures into NEW vs STILL-FAILING against the baseline", () => {
    const cmp = compare(
      report([
        ["a", false],
        ["b", false],
        ["c", true],
      ]),
      report([
        ["a", true],
        ["b", false],
        ["c", true],
      ]),
    );

    expect(cmp.newFailures.map((s) => s.fullTitle)).toEqual([title("a")]);
    expect(cmp.stillFailing.map((s) => s.fullTitle)).toEqual([title("b")]);
    expect(cmp.fixed).toEqual([]);
  });

  it("reports a spec that failed on the baseline and passes here as FIXED", () => {
    const cmp = compare(report([["a", true]]), report([["a", false]]));
    expect(cmp.fixed.map((s) => s.fullTitle)).toEqual([title("a")]);
    expect(cmp.newFailures).toEqual([]);
  });

  // A spec the baseline never ran cannot be attributed to this change.
  it("does not call a failure NEW when the baseline never ran that spec", () => {
    const cmp = compare(report([["fresh", false]]), report([["a", true]]));
    expect(cmp.newFailures).toEqual([]);
    expect(cmp.unknownToBaseline.map((s) => s.fullTitle)).toEqual([
      title("fresh"),
    ]);
  });

  it("carries no verdict at all when there is no baseline", () => {
    const cmp = compare(report([["a", false]]), null);
    expect(cmp.hasBaseline).toBe(false);
    expect(cmp.newFailures).toEqual([]);
    expect(cmp.currentFailures.map((s) => s.fullTitle)).toEqual([title("a")]);
  });

  /** A shard that dies before writing its report contributes no specs, which set difference reads as passes, so a short shard count must void the comparison. */
  it("voids the comparison when a shard report is missing", () => {
    const cmp = compare(
      report([["a", true]], { shardReports: 3 }),
      report([
        ["a", false],
        ["b", false],
      ]),
      { expectedShards: 4 },
    );
    expect(cmp.trustworthy).toBe(false);
    expect(cmp.missingShards).toBe(1);
    expect(cmp.fixed).toEqual([]);
  });

  it("trusts the comparison when every shard reported", () => {
    const cmp = compare(
      report([["a", true]], { shardReports: 4 }),
      report([["a", false]]),
      {
        expectedShards: 4,
      },
    );
    expect(cmp.trustworthy).toBe(true);
    expect(cmp.fixed.map((s) => s.fullTitle)).toEqual([title("a")]);
  });
});

/** The counts come before the names, since "did this get worse" is a subtraction. */
describe("the per-test history table", () => {
  // Baseline: a green in all 3, b red in all 3, c flaky (red in 1 of 3), d green.
  const window3 = [
    report([
      ["a", true],
      ["b", false],
      ["c", true],
      ["d", true],
    ]),
    report([
      ["a", true],
      ["b", false],
      ["c", false],
      ["d", true],
    ]),
    report([
      ["a", true],
      ["b", false],
      ["c", true],
      ["d", true],
    ]),
  ];

  it("classifies a baseline spec as green, red or FLAKY — never just pass/fail", () => {
    const cmp = compare(
      report([
        ["a", true],
        ["b", false],
        ["c", true],
        ["d", true],
      ]),
      window3,
    );
    expect(cmp.tally.green).toBe(2); // a, d
    expect(cmp.tally.red).toBe(1); // b
    expect(cmp.tally.flaky).toBe(1); // c
  });

  it("places every spec in exactly one transition cell, so the table adds up", () => {
    const cmp = compare(
      report([
        ["a", false], // green → fail: the only attributable regression
        ["b", false], // red   → fail: still failing
        ["c", false], // flaky → fail: NOT attributable
        ["d", true], // green → pass
        ["e", false], // absent from the window
      ]),
      window3,
    );
    const t = cmp.tally;
    expect(t.greenToFail).toBe(1);
    expect(t.redToFail).toBe(1);
    expect(t.flakyToFail).toBe(1);
    expect(t.greenToPass).toBe(1);
    expect(t.absentToFail).toBe(1);
    // Every baseline spec accounted for, plus the one this run added.
    const cells =
      t.greenToFail +
      t.greenToPass +
      t.redToFail +
      t.redToPass +
      t.flakyToFail +
      t.flakyToPass +
      t.absentToFail +
      t.absentToPass +
      t.notRunHere;
    expect(cells).toBe(5);
    // The one failure a reader should chase is the green→fail one, alone.
    expect(cmp.newFailures.map((s) => s.fullTitle)).toEqual([title("a")]);
  });

  it("counts a spec the baseline ran and this run did not as NOT RUN, never as passing", () => {
    const cmp = compare(report([["a", true]]), window3);
    expect(cmp.tally.notRunHere).toBe(3); // b, c, d
    expect(cmp.tally.greenToPass).toBe(1); // a
    expect(cmp.fixed).toEqual([]); // b was red in all 3 but did not run here
  });

  it("summarises the baseline PER RUN, so this run's count is comparable to it", () => {
    const cmp = compare(
      report([
        ["a", true],
        ["b", false],
        ["c", true],
        ["d", true],
      ]),
      window3,
    );
    // Per run the baseline failed 1, 2, 1, so this run's 1 is inside the swing; a
    // window aggregate would read as a fix.
    expect(cmp.totals.perRunFailed).toEqual([1, 2, 1]);
    expect(cmp.totals.currentFailed).toBe(1);
    expect(cmp.totals.currentPassed).toBe(3);
  });

  it("will not say ❌ for a new-failure count inside the suite's own swing", () => {
    // A swing of 1 between runs, so one new failure here is the noise.
    const cmp = compare(
      report([
        ["a", false], // green in all 3 → fails here
        ["b", false],
        ["c", true],
        ["d", true],
      ]),
      window3,
    );
    expect(cmp.newFailures).toHaveLength(1);
    expect(cmp.noiseFloor).toBe(1);
    const body = renderMarkdown(cmp, { baselineRef: "main@abc1234" });
    expect(body).toContain("⚠️");
    expect(body).not.toContain("### ❌");
    expect(body).toContain("swings by ±1");
    expect(body).toContain("<details><summary>");
    // Still listed — "not separable by counting" is not "ignore it".
    expect(body).toContain("🆕 new");
  });

  it("says ❌ once the new failures outrun the swing", () => {
    const cmp = compare(
      report([
        ["a", false],
        ["b", false],
        ["c", false],
        ["d", false], // two green-in-all specs fail: 2 > swing of 1
      ]),
      window3,
    );
    expect(cmp.newFailures).toHaveLength(2);
    expect(renderMarkdown(cmp, { baselineRef: "main@abc1234" })).toContain(
      "❌ <b>e2e full (k3d)</b>",
    );
  });

  it("renders both tables, with the attributable rows kept even at zero", () => {
    const body = renderMarkdown(
      compare(
        report([
          ["a", true],
          ["b", false],
          ["c", true],
          ["d", true],
        ]),
        window3,
      ),
      { baselineRef: "main@abc1234" },
    );
    // One column per baseline run plus this one, oldest first.
    expect(body).toContain("| test | −3 | −2 | −1 | this run | rate | |");
    // Zero newly-failing is a claim worth printing, not a count to hide.
    expect(body).toContain("🆕 0 new");
    // b is red in every baseline run and failed here too: 100% and "broken".
    expect(body).toMatch(/❌ \| ❌ \| ❌ \| ❌ \| 100% \| 🔴 broken/);
    // c is flaky in the window and passed here: counted in the header, kept out of
    // the table.
    expect(body).toContain("🌗 1 flaky");
    expect(body).not.toContain("› c ");
  });
});

/** Two consecutive nightlies on main differ by several specs with no change between them, so a one-run baseline manufactures regressions. */
describe("compare against a window of baseline runs", () => {
  it("does not call a failure NEW when any baseline run was already red", () => {
    const cmp = compare(report([["a", false]]), [
      report([["a", true]]),
      report([["a", false]]), // flaked here — so it was never reliably green
      report([["a", true]]),
    ]);
    expect(cmp.newFailures).toEqual([]);
    expect(cmp.stillFailing.map((s) => s.fullTitle)).toEqual([title("a")]);
  });

  it("calls a failure NEW only when every baseline run passed it", () => {
    const cmp = compare(report([["a", false]]), [
      report([["a", true]]),
      report([["a", true]]),
      report([["a", true]]),
    ]);
    expect(cmp.newFailures.map((s) => s.fullTitle)).toEqual([title("a")]);
    expect(cmp.baselineRuns).toBe(3);
  });

  it("claims FIXED only when the spec was red in every baseline run", () => {
    const flaky = compare(report([["a", true]]), [
      report([["a", false]]),
      report([["a", true]]),
    ]);
    expect(flaky.fixed).toEqual([]);

    const genuine = compare(report([["a", true]]), [
      report([["a", false]]),
      report([["a", false]]),
    ]);
    expect(genuine.fixed.map((s) => s.fullTitle)).toEqual([title("a")]);
  });

  it("reports each still-failing spec's rate across the window", () => {
    const body = renderMarkdown(
      compare(report([["a", false]]), [
        report([["a", false]]),
        report([["a", true]]),
        report([["a", false]]),
      ]),
      { baselineRef: "main" },
    );
    expect(body).toContain("| ❌ | ✅ | ❌ | ❌ | 75% | 🌗 flaky |");
  });

  it("warns that a single-run window cannot separate a regression from a flake", () => {
    const body = renderMarkdown(
      compare(report([["a", false]]), report([["a", true]])),
      {
        baselineRef: "main",
      },
    );
    expect(body).toMatch(/single baseline run/i);
    expect(body).toMatch(/flake reads as new/i);
  });
});

describe("renderMarkdown", () => {
  const opts = { baselineRef: "main@abc1234", runUrl: "https://example/run/1" };

  it("leads with the new failures and names the baseline", () => {
    const body = renderMarkdown(
      compare(
        report([
          ["a", false],
          ["b", false],
        ]),
        report([
          ["a", true],
          ["b", false],
        ]),
      ),
      opts,
    );
    expect(body).toContain("🆕 <b>1 new</b>");
    expect(body).toContain("main@abc1234");
    expect(body).toContain("a");
    // The counts come first, then the per-test evidence.
    expect(body.indexOf("🆕 <b>1 new</b>")).toBeLessThan(
      body.indexOf("| test |"),
    );
    // And the new one carries its history, not just a label.
    expect(body).toMatch(/› a \| ✅ \| ❌ \| 50% \| 🆕 new \|/);
  });

  it("says so plainly when nothing regressed but the suite is still red", () => {
    const body = renderMarkdown(
      compare(report([["b", false]]), report([["b", false]])),
      opts,
    );
    expect(body).toContain("🆕 0 new");
    expect(body).toContain("🔴 1 broken");
    // Collapsed: the whole verdict is in the summary line, the evidence behind it.
    expect(body).toMatch(/^<details><summary>.*<\/summary>/);
  });

  it("states that no baseline was available rather than implying a clean diff", () => {
    const body = renderMarkdown(compare(report([["a", false]]), null), opts);
    expect(body).toMatch(/no baseline/i);
    expect(body).not.toMatch(/new failure/i);
  });

  it("warns loudly instead of reporting a diff when a shard is missing", () => {
    const body = renderMarkdown(
      compare(
        report([["a", true]], { shardReports: 3 }),
        report([["a", false]]),
        {
          expectedShards: 4,
        },
      ),
      opts,
    );
    expect(body).toMatch(/shard/i);
    expect(body).not.toMatch(/fixed/i);
  });

  it("is green and short when the suite passes", () => {
    const body = renderMarkdown(
      compare(report([["a", true]]), report([["a", true]])),
      opts,
    );
    expect(body).toContain("✅");
  });
});

describe("the cluster smoke in the verdict", () => {
  const opts = { baselineRef: "main@abc1234", runUrl: "https://example/run/1" };

  /** The same report shape, with every spec tagged as the merge tags the smoke. */
  function smoke(specs, meta) {
    const r = report(specs, meta);
    for (const group of r.suites[0].suites)
      for (const spec of group.specs) spec.kind = "cluster";
    return r;
  }

  /** One merged report holding both kinds, as `e2e-full-collect` assembles it. */
  function merged(browser, cluster, meta) {
    const r = report(browser, meta);
    r.suites.push(...smoke(cluster).suites);
    return r;
  }

  // The shards run both kinds and the comment is the only place a reader looks, so
  // a tally that counts browser stories alone can read green on a red smoke.
  it("tallies the smoke separately from the browser stories", () => {
    const body = renderMarkdown(
      compare(
        merged(
          [["browser", true]],
          [
            ["provisioning", true],
            ["a conversation routes", false],
          ],
        ),
        merged([["browser", true]], [["provisioning", true], ["a conversation routes", true]]),
      ),
      opts,
    );

    expect(body).toContain("3 tests");
    expect(body).toContain("smoke 1/2 passed");
  });

  it("says nothing about the smoke when the run carried none", () => {
    const body = renderMarkdown(
      compare(report([["browser", true]]), report([["browser", true]])),
      opts,
    );

    expect(body).not.toMatch(/smoke/i);
  });

  // A red smoke is a regression like any other: it must reach the failure tables,
  // not just the tally.
  it("treats a failed smoke test as a new failure against a green baseline", () => {
    const cmp = compare(
      merged([["browser", true]], [["a conversation routes", false]]),
      merged([["browser", true]], [["a conversation routes", true]]),
    );

    expect(cmp.newFailures.map((s) => s.fullTitle)).toEqual([
      title("a conversation routes"),
    ]);
    expect(cmp.smoke).toEqual({
      total: 1,
      passed: 0,
      failed: 1,
      regressions: 1,
    });
  });

  // The noise floor exists because the browser stories churn night to night. The
  // smoke does not churn: it either brings the platform up or the rest of the run
  // was measured against nothing.
  it("says ❌ for one newly-red smoke test even inside the suite's swing", () => {
    // A window whose browser failures swing by 1, so a browser regression here
    // would render ⚠️.
    const window3 = [
      merged([["browser", true], ["churn", true]], [["provisioning", true]]),
      merged([["browser", true], ["churn", false]], [["provisioning", true]]),
      merged([["browser", true], ["churn", true]], [["provisioning", true]]),
    ];
    const cmp = compare(
      merged([["browser", true], ["churn", true]], [["provisioning", false]]),
      window3,
    );

    expect(cmp.noiseFloor).toBe(1);
    expect(cmp.smoke.regressions).toBe(1);
    const body = renderMarkdown(cmp, opts);
    expect(body).toContain("❌ <b>e2e full (k3d)</b>");
    expect(body).toContain("🧪 <b>1 smoke</b>");
  });

  // Not every red smoke is this PR's doing; one that is red on main too is still
  // reported, but it is not this change's ❌.
  it("does not escalate a smoke test that was already red on main", () => {
    const cmp = compare(
      merged([["browser", true]], [["provisioning", false]]),
      [
        merged([["browser", true]], [["provisioning", false]]),
        merged([["browser", true]], [["provisioning", false]]),
      ],
    );

    expect(cmp.smoke).toMatchObject({ failed: 1, regressions: 0 });
    const body = renderMarkdown(cmp, opts);
    expect(body).not.toContain("❌ <b>e2e full (k3d)</b>");
    expect(body).toContain("🧪 <b>1 smoke</b>");
    expect(body).toContain("🔴 1 broken");
  });

  // A shard writes one report per kind, so "3/4 shards" alone does not say which
  // half of the run is missing.
  it("names the report that never arrived when it voids the comparison", () => {
    const body = renderMarkdown(
      compare(
        report([["browser", true]], {
          shardReports: 1,
          missingReports: ["shard 2: cluster smoke"],
        }),
        report([["browser", true]]),
        { expectedShards: 2 },
      ),
      opts,
    );

    expect(body).toContain("missing: shard 2: cluster smoke");
  });
});
