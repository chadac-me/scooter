#!/usr/bin/env node
// merge-e2e-full-reports.mjs — merge an `e2e full (k3d)` run's per-shard reports into
// the one report its verdict, its next-run shard weights and later baselines are read
// from (see `e2e-full-collect` in .github/workflows/ci.yml). A shard runs two kinds of
// test and writes a report for each — playwright's JSON for the browser stories, vitest's
// for the cluster smoke — so the smoke results are converted into the same spec shape
// and the verdict covers both kinds.
//
// Usage:
//   node scripts/merge-e2e-full-reports.mjs --dir shard-reports --matrix '<json>' [--out report.json]
//     --dir <d>      the downloaded per-shard reports
//     --matrix <j>   the shard matrix, for what each shard was assigned
//     --out <f>      where to write the merged report (default report.json)
//
// `meta.shardReports` counts only shards that wrote EVERY report they were assigned: a
// spec absent from the merge is indistinguishable from one that passed, so the verdict
// scripts void their comparison when the count is short.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** vitest's status vocabulary mapped onto playwright's; anything not run is `skipped`,
 *  which `collectSpecs` drops. */
function statusOf(status) {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  return "skipped";
}

/** vitest names the file by its absolute path in the shard runner's checkout, which is
 *  not this machine's; trim to the repo-relative part so the file reads the same as
 *  playwright's and the weights key matches across runners. */
export function repoPath(name) {
  if (!name) return "";
  const i = name.lastIndexOf("/test/");
  return i === -1 ? name : name.slice(i + 1);
}

/**
 * A vitest JSON report as playwright-shaped suites, every spec tagged `kind: "cluster"`
 * so the weights, the sweep's short-run check and the verdict can tell the two kinds
 * apart. `ancestorTitles` becomes the suite path, so a title reused under two suites
 * stays two specs.
 */
export function clusterToSuites(report) {
  const out = [];
  for (const file of report?.testResults ?? []) {
    const path = repoPath(file.name);
    const rootSuite = { title: "", file: path, specs: [], suites: [] };
    for (const a of file.assertionResults ?? []) {
      let node = rootSuite;
      for (const title of a.ancestorTitles ?? []) {
        let child = node.suites.find((s) => s.title === title);
        if (!child) {
          child = { title, file: path, specs: [], suites: [] };
          node.suites.push(child);
        }
        node = child;
      }
      const status = statusOf(a.status);
      node.specs.push({
        title: a.title ?? "",
        file: path,
        // Read by the weights keying and the verdict's per-kind tally.
        kind: "cluster",
        tests: [
          {
            results: [
              {
                status,
                duration: Number(a.duration) || 0,
                errors: (a.failureMessages ?? []).map((message) => ({ message })),
              },
            ],
          },
        ],
      });
    }
    out.push(rootSuite);
  }
  return out;
}

/**
 * One report out of every shard's, with `meta.shardReports` counting the shards that
 * reported in full. Each shard is `{ shard, expectE2e, expectCluster, e2e, cluster }`,
 * where a report is null when the step never wrote one.
 */
export function mergeReports(shards) {
  let suites = [];
  let shardReports = 0;
  const missingReports = [];
  for (const s of shards) {
    let complete = true;
    if (s.expectE2e) {
      if (s.e2e) suites = suites.concat(s.e2e.suites ?? []);
      else {
        complete = false;
        missingReports.push(`shard ${s.shard}: browser stories`);
      }
    }
    if (s.expectCluster) {
      if (s.cluster) suites = suites.concat(clusterToSuites(s.cluster));
      else {
        complete = false;
        missingReports.push(`shard ${s.shard}: cluster smoke`);
      }
    }
    if (complete) shardReports += 1;
  }
  return {
    suites,
    meta: { shardReports, expectedShards: shards.length, missingReports },
  };
}

/** A shard's two report paths, named as the shard job uploads them. */
const e2eFile = (shard) => `report-full-shard-${shard}.json`;
const clusterFile = (shard) => `cluster-report-shard-${shard}.json`;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The shard list from the matrix, or — with no usable matrix — from the files present,
 *  which expects exactly what arrived and so cannot detect a loss. */
function planShards(dir, matrixJson) {
  let include;
  try {
    include = JSON.parse(matrixJson ?? "").include;
  } catch {
    include = null;
  }
  if (Array.isArray(include) && include.length) {
    return include.map((m) => ({
      shard: m.shard,
      expectE2e: Number(m.e2e_count) > 0,
      expectCluster: Number(m.cluster_count) > 0,
    }));
  }
  process.stderr.write("[merge] no shard matrix — inferring the plan from the files present\n");
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const shards = new Set();
  for (const f of files) {
    const m = /-shard-(\d+)\.json$/.exec(f);
    if (m) shards.add(Number(m[1]));
  }
  return [...shards]
    .sort((a, b) => a - b)
    .map((shard) => ({
      shard,
      expectE2e: files.includes(e2eFile(shard)),
      expectCluster: files.includes(clusterFile(shard)),
    }));
}

function main(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };
  const dir = opt("dir", "shard-reports");
  const out = opt("out", "report.json");

  const shards = planShards(dir, opt("matrix")).map((s) => ({
    ...s,
    e2e: readJson(join(dir, e2eFile(s.shard))),
    cluster: readJson(join(dir, clusterFile(s.shard))),
  }));
  const merged = mergeReports(shards);
  writeFileSync(out, JSON.stringify(merged));

  process.stderr.write(
    `[merge] ${merged.suites.length} top-level suites from ${merged.meta.shardReports}/${merged.meta.expectedShards} shards\n`,
  );
  for (const m of merged.meta.missingReports) {
    // An annotation, not a failure: the merge still has to produce what it can, and the
    // verdict voids its own comparison on a short count.
    process.stderr.write(`::warning::e2e-full report missing — ${m}\n`);
  }
}

// Run only as a CLI, so the spec can import the pure functions above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
