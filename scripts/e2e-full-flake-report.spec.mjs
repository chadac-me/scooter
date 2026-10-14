import { describe, expect, it } from "vitest";

import { summarizeSweep, renderMarkdown, indexHistory } from "./e2e-full-flake-report.mjs";

/** Build a minimal `--repeat-each` report: `specs` is [title, passes, failures] triples. */
function sweepReport(specs, meta) {
  return {
    meta,
    suites: [
      {
        title: "",
        file: "test/e2e/queue-durability.spec.ts",
        suites: specs.map(([title, passes, failures]) => ({
          title: "group",
          file: "test/e2e/queue-durability.spec.ts",
          // --repeat-each=N emits N sibling `specs` entries with the same title.
          specs: [
            ...Array.from({ length: passes }, () => ({
              title,
              file: "test/e2e/queue-durability.spec.ts",
              tests: [{ results: [{ status: "passed", duration: 1 }] }],
            })),
            ...Array.from({ length: failures }, () => ({
              title,
              file: "test/e2e/queue-durability.spec.ts",
              tests: [
                {
                  results: [
                    { status: "failed", duration: 1, error: { message: `boom: ${title}` } },
                  ],
                },
              ],
            })),
          ],
        })),
      },
    ],
  };
}

const title = (t) => `group › ${t}`;

describe("summarizeSweep", () => {
  it("separates a test that fails every repetition from one that fails some", () => {
    const sweep = summarizeSweep(
      sweepReport([
        ["broken", 0, 5],
        ["flaky", 3, 2],
        ["clean", 5, 0],
      ]),
      { repeat: 5 },
    );

    expect(sweep.broken.map((s) => s.fullTitle)).toEqual([title("broken")]);
    expect(sweep.flaky.map((s) => s.fullTitle)).toEqual([title("flaky")]);
    expect(sweep.clean.map((s) => s.fullTitle)).toEqual([title("clean")]);
    expect(sweep.runs).toBe(15);
    expect(sweep.failures).toBe(7);
  });

  it("ranks the flaky tests by failure rate", () => {
    const sweep = summarizeSweep(
      sweepReport([
        ["rare", 4, 1],
        ["often", 1, 4],
        ["half", 3, 2],
      ]),
      { repeat: 5 },
    );
    expect(sweep.flaky.map((s) => s.title)).toEqual(["often", "half", "rare"]);
  });

  // A shard that died mid-sweep leaves a smaller sample, which would otherwise read
  // as a confident rate.
  it("flags a test that ran fewer times than the repeat budget", () => {
    const sweep = summarizeSweep(sweepReport([["cut-short", 1, 1]]), { repeat: 5 });
    expect(sweep.short.map((s) => s.title)).toEqual(["cut-short"]);
  });

  it("is untrustworthy when a shard wrote no report", () => {
    const sweep = summarizeSweep(sweepReport([["a", 5, 0]], { shardReports: 3 }), {
      repeat: 5,
      expectedShards: 4,
    });
    expect(sweep.missingShards).toBe(1);
    expect(sweep.trustworthy).toBe(false);
  });

  it("measures nothing when no test ran", () => {
    const sweep = summarizeSweep({ suites: [] }, { repeat: 5 });
    expect(sweep.tests).toBe(0);
    expect(sweep.trustworthy).toBe(false);
  });
});

describe("renderMarkdown", () => {
  const sweep = summarizeSweep(
    sweepReport([
      ["broken", 0, 5],
      ["sometimes", 3, 2],
      ["clean", 5, 0],
    ]),
    { repeat: 5 },
  );

  it("leads with the always-red count and gives each flake its rate", () => {
    const md = renderMarkdown(sweep, { runUrl: "https://example.test/run" });
    expect(md).toContain("1 always red");
    expect(md).toContain("1 flaky");
    expect(md).toContain("**2/5** (40%)");
    expect(md).toContain("boom: sometimes");
    expect(md).toContain("https://example.test/run");
  });

  it("renders the earlier sweeps' rates for the same test", () => {
    const history = indexHistory(
      [sweepReport([["sometimes", 5, 0]]), sweepReport([["sometimes", 4, 1]])],
      ["10-11", "10-12"],
    );
    const md = renderMarkdown(sweep, { history });
    expect(md).toContain("earlier sweeps (10-11 · 10-12)");
    expect(md).toContain("0/5 · 1/5");
  });

  it("says so plainly when every repetition passed", () => {
    const green = summarizeSweep(sweepReport([["a", 5, 0]]), { repeat: 5 });
    const md = renderMarkdown(green);
    expect(md).toContain("✅");
    expect(md).toContain("no failures");
    expect(md).not.toContain("always red");
  });

  it("refuses to report a sweep that ran nothing as clean", () => {
    const md = renderMarkdown(summarizeSweep({ suites: [] }, { repeat: 5 }));
    expect(md).toContain("no tests ran");
  });
});

describe("the cluster smoke in a sweep", () => {
  /** A smoke test in the merged report: one run, tagged `kind: "cluster"`. */
  function withSmoke(report, titleText) {
    report.suites.push({
      title: "",
      file: "test/cluster/platform-smoke.spec.ts",
      suites: [
        {
          title: "group",
          file: "test/cluster/platform-smoke.spec.ts",
          specs: [
            {
              title: titleText,
              kind: "cluster",
              file: "test/cluster/platform-smoke.spec.ts",
              tests: [{ results: [{ status: "passed", duration: 1 }] }],
            },
          ],
        },
      ],
    });
    return report;
  }

  // The sweep repeats the browser stories only; the smoke runs once by design, so
  // flagging its sample as short would cry wolf on every nightly.
  it("does not read the smoke's single run as a sweep cut short", () => {
    const sweep = summarizeSweep(
      withSmoke(sweepReport([["browser", 5, 0]]), "a conversation routes"),
      { repeat: 5 },
    );

    expect(sweep.short).toEqual([]);
    expect(sweep.clean.map((s) => s.title)).toContain("a conversation routes");
  });

  it("still flags a browser story that ran short", () => {
    const sweep = summarizeSweep(
      withSmoke(sweepReport([["browser", 2, 0]]), "a conversation routes"),
      { repeat: 5 },
    );

    expect(sweep.short.map((s) => s.title)).toEqual(["browser"]);
  });
});
