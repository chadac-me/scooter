#!/usr/bin/env node
/**
 * Distribute the Playwright e2e spec files into N balanced shards for parallel CI runners,
 * weighted by per-file runtime. Weights come from a prior run's Playwright JSON report
 * (PRIOR_REPORT=path), then the committed test/e2e/shard-weights.json, then a flat
 * DEFAULT_WEIGHT; packing is LPT greedy. Output is a GitHub-Actions matrix include list as
 * JSON on stdout, each `specs` a space-joined list of repo-relative spec paths ready to
 * pass positionally to `playwright test`.
 *
 * Usage:  node test/e2e/support/shard-e2e.mjs <N>
 *         SHARDS=<N> node test/e2e/support/shard-e2e.mjs
 *         PRIOR_REPORT=prev/report.json node test/e2e/support/shard-e2e.mjs 4
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(HERE, ".."); // test/e2e
const REPO_ROOT = join(E2E_DIR, "..", ".."); // scooter/
const DEFAULTS_PATH = join(E2E_DIR, "shard-weights.json");

const DEFAULT_WEIGHT = 30; // seconds; a middling spec

/** Spec files Playwright would consider: every *.spec.ts in test/e2e by default, or with
 *  SPEC_SET=full the allowlist in test/e2e/full-specs.json that playwright.config.ts also
 *  builds the `full` project from. */
function specFiles() {
  if (process.env.SPEC_SET === "full") {
    return JSON.parse(readFileSync(join(E2E_DIR, "full-specs.json"), "utf8")).sort();
  }
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.ts"))
    .sort(); // deterministic order, so deterministic sharding for the same inputs
}

/** Committed fallback weights, { "<spec-file>": seconds }; a missing file yields {}. */
function committedWeights() {
  if (!existsSync(DEFAULTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DEFAULTS_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Per-spec-file durations (seconds) summed from a Playwright JSON report, or {} if the
 *  report is absent or unreadable. */
function priorReportWeights(reportPath) {
  if (!reportPath || !existsSync(reportPath)) return {};
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return {};
  }
  const byFile = {};
  const addDuration = (file, ms) => {
    const key = basename(file);
    byFile[key] = (byFile[key] ?? 0) + (Number(ms) || 0);
  };
  // Walk the suite tree; a spec's `file` may live on the suite or the spec node.
  const walk = (node, inheritedFile) => {
    if (!node || typeof node !== "object") return;
    const file = node.file ?? inheritedFile;
    for (const spec of node.specs ?? []) {
      const specFile = spec.file ?? file;
      for (const test of spec.tests ?? []) {
        for (const res of test.results ?? []) addDuration(specFile, res.duration);
      }
    }
    for (const child of node.suites ?? []) walk(child, file);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file);
  // ms → seconds.
  const out = {};
  for (const [k, ms] of Object.entries(byFile)) out[k] = ms / 1000;
  return out;
}

/** Resolve each spec file's weight: prior report, then committed default, then flat default. */
function resolveWeights(files, prior, committed) {
  const w = {};
  for (const f of files) {
    if (prior[f] && prior[f] > 0) w[f] = prior[f];
    else if (committed[f] && committed[f] > 0) w[f] = committed[f];
    else w[f] = DEFAULT_WEIGHT;
  }
  return w;
}

/** LPT greedy bin-packing into `n` shards, returning { specs, total } per shard. */
function packShards(files, weights, n) {
  const shards = Array.from({ length: n }, () => ({ specs: [], total: 0 }));
  const heaviestFirst = [...files].sort((a, b) => weights[b] - weights[a]);
  for (const f of heaviestFirst) {
    // Assign to the currently-lightest shard (ties go to the lowest index for determinism).
    let lightest = 0;
    for (let i = 1; i < n; i++) if (shards[i].total < shards[lightest].total) lightest = i;
    shards[lightest].specs.push(`test/e2e/${f}`);
    shards[lightest].total += weights[f];
  }
  return shards;
}

function main() {
  const n = Math.max(1, Number(process.argv[2] ?? process.env.SHARDS ?? 4));
  const files = specFiles();
  const prior = priorReportWeights(process.env.PRIOR_REPORT);
  const committed = committedWeights();
  const weights = resolveWeights(files, prior, committed);

  const source = Object.keys(prior).length ? "prior-report" : Object.keys(committed).length ? "committed-defaults" : "flat-default";
  const effN = Math.min(n, files.length) || 1; // do not create empty shards
  const shards = packShards(files, weights, effN)
    // Keep only non-empty shards (defensive; effN caps this already).
    .filter((s) => s.specs.length > 0);

  const include = shards.map((s, i) => ({
    shard: i + 1,
    specs: s.specs.join(" "),
    // Human-readable, not consumed by the matrix.
    est_seconds: Math.round(s.total),
  }));

  // Diagnostics to stderr so stdout stays pure JSON for `$(...)` capture.
  process.stderr.write(
    `[shard-e2e] ${files.length} specs → ${include.length} shards (weights: ${source})\n` +
      include.map((s) => `  shard ${s.shard}: ~${s.est_seconds}s — ${s.specs}`).join("\n") +
      "\n",
  );

  process.stdout.write(JSON.stringify({ include }));
}

main();
