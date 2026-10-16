import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  packTests,
  priorReportWeights,
  reportWeights,
  resolveWeights,
  testKey,
  windowReportWeights,
} from "./shard-tests.mjs";
/** A minimal Playwright JSON report: one top-level suite per file, durations in ms. */
function report(byTest) {
  const files = {};
  for (const [key, ms] of Object.entries(byTest)) {
    const [file, title] = key.split("::");
    (files[file] ??= []).push({ file, title, tests: [{ results: [{ duration: ms }] }] });
  }
  return JSON.stringify({
    suites: Object.entries(files).map(([file, specs]) => ({ file, specs })),
  });
}

function reportDir(runs) {
  const dir = mkdtempSync(join(tmpdir(), "shard-tests-"));
  runs.forEach((byTest, i) => {
    // One directory per run, as `gh run download` lays them out.
    const sub = join(dir, `run-${i}`);
    mkdirSync(sub);
    writeFileSync(join(sub, "report.json"), report(byTest));
  });
  return dir;
}

const e2eTest = (file, title) => ({ kind: "e2e", file: `test/e2e/${file}`, title });
const e2e = (title, file = "a.spec.ts") => ({ kind: "e2e", file: `test/e2e/${file}`, title });
const cluster = (title) => ({ kind: "cluster", file: "test/cluster/platform-smoke.spec.ts", title });

describe("reportWeights", () => {
  // The merged report carries both kinds now (scripts/merge-e2e-full-reports.mjs), and
  // testKey is per kind: keying every spec as `e2e` would file the cluster durations
  // under names no test has, and the smoke would be packed at the flat default forever.
  it("keys each spec by the kind the merge tagged it with", () => {
    const w = reportWeights({
      suites: [
        {
          title: "",
          file: "test/e2e/a.spec.ts",
          specs: [{ title: "browser", tests: [{ results: [{ duration: 20_000 }] }] }],
          suites: [
            {
              title: "platform smoke",
              file: "test/cluster/platform-smoke.spec.ts",
              specs: [
                {
                  title: "provisioning",
                  kind: "cluster",
                  tests: [{ results: [{ duration: 60_000 }] }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(w).toEqual({
      [testKey(e2e("browser"))]: 20,
      [testKey(cluster("provisioning"))]: 60,
    });
  });
});

describe("reportWeights under a sweep", () => {
  // --repeat-each lists every repetition as its own spec under one key. Keeping whichever
  // the report lists last weighted a 90s test at 18s in a real nightly; take the max.
  it("weights one pass as the slowest repetition, not the last one listed", () => {
    const rep = (ms) => ({ title: "flaky", tests: [{ results: [{ duration: ms }] }] });
    const w = reportWeights({
      suites: [{ file: "test/e2e/a.spec.ts", specs: [rep(90_000), rep(18_000), rep(18_000)] }],
    });
    expect(w).toEqual({ [testKey(e2e("flaky"))]: 90 });
  });
});

describe("resolveWeights", () => {
  it("prefers a measured duration over the committed fallback", () => {
    const tests = [e2e("slow")];
    const w = resolveWeights(tests, {
      prior: { [testKey(tests[0])]: 90 },
      committed: { [testKey(tests[0])]: 10 },
    });
    expect(w[testKey(tests[0])]).toBe(90);
  });

  // The sweep repeats the browser specs only, so a shard holding cluster tests is
  // lighter than its e2e weight suggests — packing them as if they scaled too would
  // leave that shard idle while the others run five times as long.
  // The committed table is a FLOOR: every way a weight goes wrong makes it too SMALL, and
  // too-small is what overloads a shard — so a measured value below the table does not win.
  it("floors a measured duration with the committed one", () => {
    const tests = [e2e("truncated")];
    const w = resolveWeights(tests, {
      prior: { [testKey(tests[0])]: 5 },
      committed: { [testKey(tests[0])]: 100 },
    });
    expect(w[testKey(tests[0])]).toBe(100);
  });

  it("falls back to the flat default for a test absent from both", () => {
    const w = resolveWeights([e2e("new")]);
    expect(w[testKey(e2e("new"))]).toBeGreaterThan(0);
  });

  it("scales the e2e weights by the repeat budget and leaves cluster tests alone", () => {
    const tests = [e2e("browser"), cluster("provisioning")];
    const w = resolveWeights(tests, {
      committed: { [testKey(tests[0])]: 20, [testKey(tests[1])]: 60 },
      repeat: 5,
    });
    expect(w[testKey(tests[0])]).toBe(100);
    expect(w[testKey(tests[1])]).toBe(60);
  });

  it("treats a missing repeat as one pass", () => {
    const tests = [e2e("browser")];
    const w = resolveWeights(tests, { committed: { [testKey(tests[0])]: 20 } });
    expect(w[testKey(tests[0])]).toBe(20);
  });
});

describe("packTests under a sweep", () => {
  it("balances the repeated cost, not the single-pass one", () => {
    const tests = [e2e("heavy"), e2e("light"), cluster("slow-cluster")];
    const committed = {
      [testKey(tests[0])]: 50,
      [testKey(tests[1])]: 50,
      [testKey(tests[2])]: 200,
    };
    // At ×1 the cluster test outweighs both e2e tests and shares a shard with
    // neither; at ×5 each e2e test (250s) outweighs it instead.
    const shards = packTests(tests, resolveWeights(tests, { committed, repeat: 5 }), 2);
    const totals = shards.map((s) => s.total).sort((a, b) => a - b);
    expect(totals).toEqual([250, 450]);
    const withCluster = shards.find((s) => s.tests.some((t) => t.kind === "cluster"));
    expect(withCluster.tests).toHaveLength(2);
  });
});

describe("priorReportWeights", () => {
  it("keys each test as '<kind> <file basename> <title>', matching the weights table", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-tests-"));
    const path = join(dir, "report.json");
    writeFileSync(path, report({ "a.spec.ts::streams a reply": 12_000 }));
    expect(priorReportWeights(path)).toEqual({ "e2e a.spec.ts streams a reply": 12 });
  });

  it("sums every result for a test, so a retried test carries its whole cost", () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-tests-"));
    const path = join(dir, "report.json");
    writeFileSync(
      path,
      JSON.stringify({
        suites: [
          {
            file: "a.spec.ts",
            specs: [
              {
                file: "a.spec.ts",
                title: "retried",
                tests: [{ results: [{ duration: 5_000 }, { duration: 3_000 }] }],
              },
            ],
          },
        ],
      }),
    );
    expect(priorReportWeights(path)).toEqual({ "e2e a.spec.ts retried": 8 });
  });
});

describe("windowReportWeights", () => {
  it("takes the per-test MAX across runs, so a truncated run cannot under-weight a test", () => {
    // `heavy` ran fully in run 0 and was cut short in run 1 (the shard died partway).
    // A mean would report ~63s and pack it as a light test; the max keeps it at 120s.
    const dir = reportDir([
      { "a.spec.ts::heavy": 120_000, "a.spec.ts::light": 10_000 },
      { "a.spec.ts::heavy": 7_000, "a.spec.ts::light": 11_000 },
    ]);
    expect(windowReportWeights(dir)).toEqual({
      "e2e a.spec.ts heavy": 120,
      "e2e a.spec.ts light": 11,
    });
  });

  it("recurses into the per-run directories `gh run download` creates", () => {
    const dir = reportDir([{ "a.spec.ts::one": 9_000 }, { "b.spec.ts::two": 4_000 }]);
    expect(Object.keys(windowReportWeights(dir)).sort()).toEqual([
      "e2e a.spec.ts one",
      "e2e b.spec.ts two",
    ]);
  });

  it("is empty for a missing directory, so callers fall back to the table", () => {
    expect(windowReportWeights(join(tmpdir(), "definitely-not-here"))).toEqual({});
    expect(windowReportWeights(undefined)).toEqual({});
  });
});

describe("packTests", () => {
  it("never emits an empty shard while tests remain unassigned", () => {
    const tests = ["a", "b", "c", "d"].map((t) => e2eTest("a.spec.ts", t));
    const weights = resolveWeights(tests, { committed: { [testKey(tests[0])]: 300 } });
    for (const s of packTests(tests, weights, 4)) expect(s.tests.length).toBeGreaterThan(0);
  });

  it("keeps the heaviest test off the heaviest shard (LPT, not round-robin)", () => {
    const tests = [
      e2eTest("a.spec.ts", "big"),
      e2eTest("a.spec.ts", "mid"),
      e2eTest("a.spec.ts", "small"),
    ];
    const weights = {
      [testKey(tests[0])]: 100,
      [testKey(tests[1])]: 60,
      [testKey(tests[2])]: 50,
    };
    // big alone (100) vs mid+small (110) — LPT seeds the heaviest first, then fills.
    expect(
      packTests(tests, weights, 2)
        .map((s) => s.tests.length)
        .sort(),
    ).toEqual([1, 2]);
  });

  it("balances the committed table within 15% across 4 shards", () => {
    // The regression this guards: a table in the wrong units plans four equal-looking
    // shards and produces a 9-minute one beside a 24-minute one. That shows up here as
    // a spread, rather than as a red nightly hours later.
    const raw = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "test-weights.json"), "utf8"),
    );
    delete raw._comment;
    const tests = Object.keys(raw).map((k) => {
      const [kind, file, ...title] = k.split(" ");
      return { kind, file, title: title.join(" ") };
    });
    const totals = packTests(tests, raw, 4).map((s) => s.total);
    expect(Math.max(...totals) / Math.min(...totals)).toBeLessThan(1.15);
  });
});
