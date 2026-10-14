import { describe, expect, it } from "vitest";

import { clusterToSuites, mergeReports } from "./merge-e2e-full-reports.mjs";
import { collectSpecs } from "./flake-focus-report.mjs";

/** A vitest JSON report: `tests` is [ancestors, title, status] triples. */
function vitestReport(file, tests) {
  return {
    testResults: [
      {
        name: `/build/source/${file}`,
        assertionResults: tests.map(([ancestorTitles, title, status]) => ({
          ancestorTitles,
          title,
          fullName: [...ancestorTitles, title].join(" > "),
          status,
          duration: 1500,
          failureMessages: status === "failed" ? ["expected 500 to be 200"] : [],
        })),
      },
    ],
  };
}

/** A playwright JSON report with one spec per title. */
function playwrightReport(file, titles) {
  return {
    suites: [
      {
        title: "",
        file,
        specs: titles.map((title) => ({
          title,
          file,
          tests: [{ results: [{ status: "passed", duration: 1 }] }],
        })),
      },
    ],
  };
}

describe("clusterToSuites", () => {
  it("renders a vitest test as a spec the verdict scripts can read", () => {
    const suites = clusterToSuites(
      vitestReport("test/cluster/platform-smoke.spec.ts", [
        [["platform smoke"], "a conversation routes", "failed"],
      ]),
    );

    const specs = collectSpecs({ suites });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      fullTitle: "platform smoke › a conversation routes",
      title: "a conversation routes",
      file: "test/cluster/platform-smoke.spec.ts",
      kind: "cluster",
      runs: 1,
      failed: 1,
    });
    expect(specs[0].errors[0]).toContain("expected 500 to be 200");
  });

  // The shard runs its assigned smoke tests with vitest's -t, and the rest are
  // reported as skipped; counting them would read as tests that passed nowhere.
  it("drops the tests the shard's selector skipped", () => {
    const suites = clusterToSuites(
      vitestReport("test/cluster/platform-smoke.spec.ts", [
        [["platform smoke"], "mine", "passed"],
        [["platform smoke"], "another shard's", "skipped"],
      ]),
    );

    const specs = collectSpecs({ suites }).filter((s) => s.runs > 0);
    expect(specs.map((s) => s.title)).toEqual(["mine"]);
  });

  it("keeps two tests of the same name under different suites apart", () => {
    const suites = clusterToSuites(
      vitestReport("test/cluster/event-backfill.spec.ts", [
        [["backfill", "with history"], "restores", "passed"],
        [["backfill", "without history"], "restores", "failed"],
      ]),
    );

    expect(collectSpecs({ suites }).map((s) => s.fullTitle)).toEqual([
      "backfill › with history › restores",
      "backfill › without history › restores",
    ]);
  });

  it("survives a report with no results at all", () => {
    expect(clusterToSuites(null)).toEqual([]);
    expect(clusterToSuites({})).toEqual([]);
  });
});

describe("mergeReports", () => {
  const shard = (n, over = {}) => ({
    shard: n,
    expectE2e: true,
    expectCluster: true,
    e2e: playwrightReport("test/e2e/a.spec.ts", [`browser ${n}`]),
    cluster: vitestReport("test/cluster/platform-smoke.spec.ts", [
      [["smoke"], `smoke ${n}`, "passed"],
    ]),
    ...over,
  });

  it("merges the browser stories and the cluster smoke of every shard", () => {
    const merged = mergeReports([shard(1), shard(2)]);

    expect(collectSpecs(merged).map((s) => s.title).sort()).toEqual([
      "browser 1",
      "browser 2",
      "smoke 1",
      "smoke 2",
    ]);
    expect(merged.meta).toMatchObject({ shardReports: 2, expectedShards: 2 });
    expect(merged.meta.missingReports).toEqual([]);
  });

  // A spec absent from the merge is indistinguishable from one that passed, so a
  // shard counts as reported only when every report it was assigned arrived.
  it("does not count a shard that lost one of its two reports", () => {
    const merged = mergeReports([shard(1), shard(2, { e2e: null })]);

    expect(merged.meta.shardReports).toBe(1);
    expect(merged.meta.missingReports).toEqual(["shard 2: browser stories"]);
    expect(collectSpecs(merged).map((s) => s.title)).toContain("smoke 2");
  });

  it("counts a shard with no cluster tests as complete on its browser report alone", () => {
    const merged = mergeReports([
      shard(1, { expectCluster: false, cluster: null }),
    ]);

    expect(merged.meta.shardReports).toBe(1);
    expect(merged.meta.missingReports).toEqual([]);
  });

  it("names a missing cluster report", () => {
    const merged = mergeReports([shard(1, { cluster: null })]);

    expect(merged.meta.shardReports).toBe(0);
    expect(merged.meta.missingReports).toEqual(["shard 1: cluster smoke"]);
  });
});
