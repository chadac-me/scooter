#!/usr/bin/env node
/**
 * Distribute individual tests (not spec files) into N balanced shards. A file is an atomic
 * unit and some files are enormous, so per-test packing is what keeps the shards balanced;
 * playwright and cluster tests share one pool so the weights balance across both kinds.
 * Selection is by escaped title (see test-inventory.mjs), and completeness is asserted
 * rather than assumed: the plan fails unless its selections cover the inventory exactly once.
 *
 * Usage:
 *   node test/e2e/support/shard-tests.mjs <N>
 *   SHARDS=<N> PRIOR_REPORT=prev/report.json REPEAT=<r> node test/e2e/support/shard-tests.mjs
 *   SHARDS=<N> PRIOR_REPORT_DIR=prior REPEAT=<r> node test/e2e/support/shard-tests.mjs
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { combinedInventory, verify, escapeForGrep } from "./test-inventory.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(HERE, "..");
const WEIGHTS_PATH = join(E2E_DIR, "test-weights.json");

const DEFAULT_WEIGHT = 30; // seconds; a middling test

/** A stable key for a test across runs, "<kind> <file basename> <title>", using the
 *  basename so the key survives a checkout at a different prefix. */
export function testKey(t) {
  return `${t.kind} ${basename(t.file)} ${t.title}`;
}

/** Committed fallback weights keyed by testKey; missing or unparseable yields {}. */
function committedWeights() {
  if (!existsSync(WEIGHTS_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(WEIGHTS_PATH, "utf8"));
    delete raw._comment;
    return raw;
  } catch {
    return {};
  }
}

/** Per-test durations (seconds) from a prior merged report, keyed like the weights file.
 *  The merge tags the cluster smoke; an untagged spec is a browser story. A sweep lists
 *  each repetition as its own spec under the same key, so one pass's weight is the MAX
 *  of them, not whichever repetition the report happens to list last. */
export function reportWeights(report) {
  const out = {};
  const walk = (node, file) => {
    if (!node || typeof node !== "object") return;
    const f = node.file ?? file;
    for (const spec of node.specs ?? []) {
      const ms = (spec.tests ?? [])
        .flatMap((t) => t.results ?? [])
        .reduce((a, r) => a + (Number(r.duration) || 0), 0);
      if (ms > 0) {
        const k = `${spec.kind ?? "e2e"} ${basename(spec.file ?? f)} ${spec.title}`;
        out[k] = Math.max(out[k] ?? 0, ms / 1000);
      }
    }
    for (const child of node.suites ?? []) walk(child, f);
  };
  for (const suite of report?.suites ?? []) walk(suite, suite.file);
  return out;
}

/** The same, read from the previous run's merged report; missing or unparseable yields {}. */
export function priorReportWeights(reportPath) {
  if (!reportPath || !existsSync(reportPath)) return {};
  try {
    return reportWeights(JSON.parse(readFileSync(reportPath, "utf8")));
  } catch {
    return {};
  }
}

/** Per-test MAX across every report under `dir`, searched recursively because `gh run
 *  download` nests a directory per run. MAX rather than a mean: a shard that died partway
 *  under-reports the tests it reached, and averaging that in is what overloads a shard. */
export function windowReportWeights(dir) {
  if (!dir || !existsSync(dir)) return {};
  const out = {};
  const walkDir = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walkDir(p);
      else if (ent.name.endsWith(".json")) {
        for (const [k, secs] of Object.entries(priorReportWeights(p))) {
          if (secs > 0) out[k] = Math.max(out[k] ?? 0, secs);
        }
      }
    }
  };
  walkDir(dir);
  return out;
}

/**
 * One weight per test in seconds: max(measured, committed, DEFAULT_WEIGHT). The committed
 * table is a FLOOR on the measured value, not a fallback for when it is missing: every way
 * a weight goes wrong here makes it too SMALL, and too-small is the one that overloads a
 * shard. `repeat` scales the e2e weights only: the cluster
 * tests run once whatever the sweep asks for, so a shard holding them would otherwise
 * be packed as if they scaled too.
 */
export function resolveWeights(tests, { prior = {}, committed = {}, repeat = 1 } = {}) {
  const reps = Math.max(1, Number(repeat) || 1);
  const weights = {};
  for (const t of tests) {
    const k = testKey(t);
    const measured = prior[k] > 0 ? prior[k] : 0;
    const floor = committed[k] > 0 ? committed[k] : DEFAULT_WEIGHT;
    const base = Math.max(measured, floor);
    weights[k] = t.kind === "e2e" ? base * reps : base;
  }
  return weights;
}

/** LPT greedy: heaviest test first, onto the currently-lightest shard. */
export function packTests(tests, weights, n) {
  const shards = Array.from({ length: n }, () => ({ tests: [], total: 0 }));
  const heaviest = [...tests].sort((a, b) => {
    const d =
      (weights[testKey(b)] ?? DEFAULT_WEIGHT) - (weights[testKey(a)] ?? DEFAULT_WEIGHT);
    // Tie-break on the key so the plan is deterministic for identical inputs.
    return d !== 0 ? d : testKey(a).localeCompare(testKey(b));
  });
  for (const t of heaviest) {
    let lightest = 0;
    for (let i = 1; i < n; i++) if (shards[i].total < shards[lightest].total) lightest = i;
    shards[lightest].tests.push(t);
    shards[lightest].total += weights[testKey(t)] ?? DEFAULT_WEIGHT;
  }
  return shards;
}

/** Every inventory test must appear in exactly one shard; throws naming the tests at fault. */
export function assertCoverage(inventoryTests, shards) {
  const seen = new Map();
  for (const [i, s] of shards.entries()) {
    for (const t of s.tests) {
      const k = testKey(t);
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push(i + 1);
    }
  }
  const missing = inventoryTests.filter((t) => !seen.has(testKey(t)));
  const duplicated = [...seen.entries()].filter(([, where]) => where.length > 1);

  if (missing.length || duplicated.length) {
    const lines = [];
    if (missing.length) {
      lines.push(`${missing.length} test(s) assigned to NO shard:`);
      for (const t of missing.slice(0, 10)) {
        lines.push(`  - [${t.kind}] ${basename(t.file)} :: ${t.title}`);
      }
    }
    if (duplicated.length) {
      lines.push(`${duplicated.length} test(s) assigned to MORE THAN ONE shard:`);
      for (const [k, where] of duplicated.slice(0, 10)) {
        lines.push(`  - shards ${where.join(",")} :: ${k}`);
      }
    }
    throw new Error(`coverage assertion failed\n${lines.join("\n")}`);
  }
  return { covered: seen.size };
}

/** Build the per-shard selector strings (escaped titles joined with |); an empty string
 *  means the shard has no tests of that kind and the workflow must skip the step. */
export function selectorsFor(shardTests) {
  const grepFor = (kind) => {
    const titles = shardTests
      .filter((t) => t.kind === kind)
      .map((t) => escapeForGrep(t.title));
    return titles.length ? titles.join("|") : "";
  };
  return { e2e_grep: grepFor("e2e"), cluster_grep: grepFor("cluster") };
}

function main() {
  const n = Math.max(1, Number(process.argv[2] ?? process.env.SHARDS ?? 4));

  // Refuse to plan against a suite that cannot be addressed by title.
  const all = combinedInventory();
  const v = verify(all);
  if (!v.ok) {
    process.stderr.write(
      `[shard-tests] inventory is not shardable:\n${v.problems.map((p) => `  - ${p}`).join("\n")}\n`,
    );
    process.exit(1);
  }

  // PRIOR_REPORT_DIR is a window of recent runs (per-test max); PRIOR_REPORT is a single
  // report. Either may be empty, in which case the committed table carries the plan.
  const prior = process.env.PRIOR_REPORT_DIR
    ? windowReportWeights(process.env.PRIOR_REPORT_DIR)
    : priorReportWeights(process.env.PRIOR_REPORT);
  const committed = committedWeights();
  const repeat = Math.max(1, Number(process.env.REPEAT ?? 1) || 1);
  const weights = resolveWeights(all, { prior, committed, repeat });
  const source = Object.keys(prior).length
    ? "prior-report"
    : Object.keys(committed).length
      ? "committed"
      : "flat-default";

  const effN = Math.min(n, all.length) || 1;
  const shards = packTests(all, weights, effN);
  assertCoverage(all, shards);

  const include = shards.map((s, i) => {
    const sel = selectorsFor(s.tests);
    return {
      shard: i + 1,
      ...sel,
      e2e_count: s.tests.filter((t) => t.kind === "e2e").length,
      cluster_count: s.tests.filter((t) => t.kind === "cluster").length,
      est_seconds: Math.round(s.total),
    };
  });

  const totals = include.map((s) => s.est_seconds);
  process.stderr.write(
    `[shard-tests] ${all.length} tests → ${include.length} shards (weights: ${source}, e2e ×${repeat})\n` +
      `[shard-tests] spread: min ${Math.min(...totals)}s  max ${Math.max(...totals)}s\n` +
      include
        .map(
          (s) =>
            `  shard ${s.shard}: ~${s.est_seconds}s — ${s.e2e_count} e2e + ${s.cluster_count} cluster`,
        )
        .join("\n") +
      "\n",
  );

  process.stdout.write(JSON.stringify({ include }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
