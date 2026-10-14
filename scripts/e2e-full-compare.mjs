#!/usr/bin/env node
// e2e-full-compare.mjs — diff an `e2e full (k3d)` run against a window of recent
// runs on main and render the verdict section (see `e2e-full-collect` in ci.yml).
// The full suite is flaky night to night, so a raw failure list carries little
// information; the diff against main is what a reader can act on.
//
// Usage:
//   node scripts/e2e-full-compare.mjs <report.json> [options]
//     --baseline <f>        a merged report from a recent full run on main (repeatable)
//     --baseline-label <l>  column header for the nth --baseline (repeatable, positional)
//     --baseline-ref <r>    how to name the newest of them, e.g. `main@abc1234`
//     --run-url <url>       link back to this workflow run
//     --expected-shards <n> how many shard reports the merge should have seen
//
// Output: the comment body on stdout; with $GITHUB_OUTPUT set it also writes
// `new_failures` / `fixed` / `still_failing` / `trustworthy`.

import { readFileSync, appendFileSync } from "node:fs";

import { collectSpecs } from "./flake-focus-report.mjs";

/**
 * Bucket this run's specs against a window of recent runs on the default branch.
 * A failure is new only if every baseline run that executed the spec passed it,
 * and fixed only if every one failed it; one red run in the window makes it flaky.
 * `retries: 0` is policy (playwright.config.ts), so a spec has exactly one result
 * per run.
 */
export function compare(current, baselines, opts = {}) {
  const runs = (Array.isArray(baselines) ? baselines : [baselines]).filter(
    Boolean,
  );
  const cur = collectSpecs(current).filter((s) => s.runs > 0);
  const curByTitle = new Map(cur.map((s) => [s.fullTitle, s]));

  // Per spec title across the window: how many baseline runs ran it and how many
  // it failed in.
  const runSpecs = runs.map((run) =>
    collectSpecs(run).filter((x) => x.runs > 0),
  );
  const history = new Map();
  for (const [i, specs] of runSpecs.entries()) {
    for (const s of specs) {
      const h = history.get(s.fullTitle) ?? {
        ran: 0,
        failed: 0,
        spec: s,
        // Per baseline run, oldest first: "pass" | "fail" | "absent".
        seq: Array(runSpecs.length).fill("absent"),
      };
      h.ran += 1;
      if (s.failed > 0) h.failed += 1;
      h.seq[i] = s.failed > 0 ? "fail" : "pass";
      history.set(s.fullTitle, h);
    }
  }

  // Baseline class over the runs that ran it: green, red or flaky, or null with no
  // baseline at all.
  const classOf = (h) =>
    runs.length === 0
      ? null
      : !h
        ? "absent"
        : h.failed === 0
          ? "green"
          : h.failed === h.ran
            ? "red"
            : "flaky";
  const annotate = (s) => {
    const h = history.get(s.fullTitle);
    return { ...s, history: h, baselineClass: classOf(h) };
  };

  const currentFailures = cur.filter((s) => s.failed > 0).map(annotate);
  const hasBaseline = runs.length > 0;

  // Specs absent because their shard died are indistinguishable from passes, so
  // the comparison is void.
  const shardReports = current?.meta?.shardReports;
  const expectedShards = opts.expectedShards ?? null;
  const missingShards =
    expectedShards != null && Number.isFinite(shardReports)
      ? Math.max(0, expectedShards - shardReports)
      : 0;
  const trustworthy = hasBaseline && missingShards === 0;

  const empty = {
    newFailures: [],
    fixed: [],
    stillFailing: [],
    unknownToBaseline: [],
  };

  const buckets = !trustworthy
    ? empty
    : {
        // Green in every baseline run that ran it.
        newFailures: currentFailures.filter((s) => s.baselineClass === "green"),
        stillFailing: currentFailures.filter(
          (s) => s.baselineClass === "red" || s.baselineClass === "flaky",
        ),
        // Absent from the window entirely: a new spec, a renamed title or a newly
        // allowlisted one.
        unknownToBaseline: currentFailures.filter(
          (s) => s.baselineClass === "absent",
        ),
        // Red in every baseline run that ran it, green here.
        fixed: [...history.values()]
          .filter(
            (h) =>
              h.failed === h.ran &&
              h.ran > 0 &&
              curByTitle.get(h.spec.fullTitle)?.failed === 0,
          )
          .map((h) => ({ ...h.spec, history: h })),
      };

  // Every spec in exactly one baseline→current cell; `notRunHere` is the one
  // non-transition cell.
  const tally = {
    green: 0,
    red: 0,
    flaky: 0,
    greenToFail: 0,
    greenToPass: 0,
    redToFail: 0,
    redToPass: 0,
    flakyToFail: 0,
    flakyToPass: 0,
    absentToFail: 0,
    absentToPass: 0,
    notRunHere: 0,
  };
  for (const h of history.values()) {
    const cls = classOf(h);
    tally[cls] += 1;
    const here = curByTitle.get(h.spec.fullTitle);
    if (!here) tally.notRunHere += 1;
    else tally[`${cls}To${here.failed > 0 ? "Fail" : "Pass"}`] += 1;
  }
  for (const s of cur)
    if (!history.has(s.fullTitle))
      tally[`absentTo${s.failed > 0 ? "Fail" : "Pass"}`] += 1;

  // One row per test with its own execution history, in the new / broken / flaky /
  // fixed vocabulary.
  const statusOf = (h, here) => {
    if (!here) return "not-run";
    const ran = h?.ran ?? 0;
    if (here.failed > 0)
      return ran === 0
        ? "new-test"
        : h.failed === 0
          ? "new"
          : h.failed === ran
            ? "broken"
            : "flaky";
    if (ran === 0) return "pass";
    // Passed here but failed somewhere in the window is a fix only if it was red
    // every time.
    return h.failed === ran ? "fixed" : h.failed > 0 ? "flaky-pass" : "pass";
  };
  const rows = [];
  for (const t of new Set([...history.keys(), ...curByTitle.keys()])) {
    const h = history.get(t);
    const here = curByTitle.get(t);
    const spec = here ?? h.spec;
    const seq = [
      ...(h?.seq ?? Array(runSpecs.length).fill("absent")),
      here ? (here.failed > 0 ? "fail" : "pass") : "absent",
    ];
    const ran = seq.filter((x) => x !== "absent").length;
    const failed = seq.filter((x) => x === "fail").length;
    rows.push({
      file: spec.file,
      title: spec.title,
      // The cluster smoke, which the merge tags; everything else is a browser story.
      kind: spec.kind ?? "e2e",
      fullTitle: t,
      seq,
      status: statusOf(h, here),
      rate: ran ? Math.round((100 * failed) / ran) : null,
    });
  }
  // Worst first: what this change broke, then what is permanently broken, then noise.
  const RANK = {
    new: 0,
    "new-test": 1,
    broken: 2,
    flaky: 3,
    "not-run": 4,
    fixed: 5,
    "flaky-pass": 6,
    pass: 7,
  };
  rows.sort(
    (a, b) =>
      RANK[a.status] - RANK[b.status] ||
      b.rate - a.rate ||
      a.fullTitle.localeCompare(b.fullTitle),
  );
  const count = (...s) => rows.filter((r) => s.includes(r.status)).length;
  const statusCounts = {
    new: count("new", "new-test"),
    broken: count("broken"),
    // A known-flaky test that happened to pass is still flaky.
    flaky: count("flaky", "flaky-pass"),
    fixed: count("fixed"),
    notRun: count("not-run"),
  };

  return {
    ...buckets,
    currentFailures,
    hasBaseline,
    baselineRuns: runs.length,
    trustworthy,
    missingShards,
    shardReports,
    expectedShards,
    // Which of the two reports a shard owes went missing, as the merge named them.
    missingReports: current?.meta?.missingReports ?? [],
    totalSpecs: cur.length,
    // The cluster smoke runs in the same shards as the browser stories, so the
    // verdict names it separately rather than burying it in one total: the browser
    // stories are read through the platform the smoke is testing, so "17 of 18 passed"
    // means something quite different when the one failure is the smoke.
    smoke: {
      total: cur.filter((s) => s.kind === "cluster").length,
      passed: cur.filter((s) => s.kind === "cluster" && s.failed === 0).length,
      failed: cur.filter((s) => s.kind === "cluster" && s.failed > 0).length,
      // A smoke test that was not already red in the window. Unlike the browser
      // stories the smoke has no noise floor to hide behind — it either comes up or
      // the run means nothing — so one of these is an ❌ on its own.
      regressions: rows.filter(
        (r) =>
          r.kind === "cluster" &&
          (r.status === "new" || r.status === "new-test"),
      ).length,
    },
    tally,
    rows,
    statusCounts,
    runLabels: opts.runLabels ?? null,
    // The suite's own swing between baseline runs; a new-failure count at or under
    // it is noise.
    noiseFloor:
      runSpecs.length > 1
        ? Math.max(
            ...runSpecs.map((s) => s.filter((x) => x.failed > 0).length),
          ) -
          Math.min(...runSpecs.map((s) => s.filter((x) => x.failed > 0).length))
        : 0,
    // The baseline is summarised per run (average and range), which is what this
    // run's single count is comparable to.
    totals: {
      baselineSpecs: history.size,
      perRunFailed: runSpecs.map(
        (specs) => specs.filter((s) => s.failed > 0).length,
      ),
      perRunSpecs: runSpecs.map((specs) => specs.length),
      currentSpecs: cur.length,
      currentPassed: cur.length - currentFailures.length,
      currentFailed: currentFailures.length,
    },
  };
}

const SYM = { pass: "✅", fail: "❌", absent: "·" };
const BADGE = {
  new: "🆕 new",
  "new-test": "🆕 new test",
  broken: "🔴 broken",
  flaky: "🌗 flaky",
  "flaky-pass": "🌗 flaky",
  fixed: "✅ fixed",
  "not-run": "· not run",
  pass: "",
};

/** Column headers for the history strip: the caller's labels when it has them, else "runs ago". */
function columns(cmp) {
  const n = cmp.baselineRuns;
  const given = cmp.runLabels;
  if (given?.length === n) return [...given, "this run"];
  return [...Array.from({ length: n }, (_, i) => `−${n - i}`), "this run"];
}

/** One row per actionable test; a known-flaky test that passed here is counted in the header and omitted. */
function historyTable(cmp) {
  const cols = columns(cmp);
  const shown = cmp.rows.filter(
    (r) => !["pass", "flaky-pass"].includes(r.status),
  );
  if (!shown.length) return "";
  return [
    `| test | ${cols.join(" | ")} | rate | |`,
    `|---|${cols.map(() => ":--:").join("|")}|--:|---|`,
    ...shown.map(
      (r) =>
        `| \`${r.file.replace(/^.*\//, "")}\` › ${r.title} | ${r.seq
          .map((x) => SYM[x])
          .join(" | ")} | ${r.rate}% | ${BADGE[r.status]} |`,
    ),
  ].join("\n");
}

/** The verdict as one collapsed section: the whole result in the `<summary>` line, the per-test evidence behind a click. */
export function renderMarkdown(cmp, opts = {}) {
  const { baselineRef, runUrl } = opts;
  const c = cmp.statusCounts;
  const tests = `${cmp.totalSpecs} test${cmp.totalSpecs === 1 ? "" : "s"}`;
  // "of which N are the cluster smoke": a green suite with a red smoke test is not a
  // green run, and the smoke is what the browser stories rest on.
  const smoke = cmp.smoke?.total
    ? ` · smoke ${cmp.smoke.passed}/${cmp.smoke.total} passed`
    : "";
  const tally = `${tests} · ${cmp.totalSpecs - cmp.currentFailures.length} passed · ${cmp.currentFailures.length} failed${smoke}`;
  let summary;
  const body = [];

  if (cmp.missingShards > 0) {
    summary = `⚠️ <b>e2e full (k3d)</b> — no comparison: ${cmp.shardReports}/${cmp.expectedShards} shards reported`;
    body.push(
      [
        "A report that never arrived leaves its specs out of the merge, which set difference reads as passing. Re-run failed jobs.",
        ...(cmp.missingReports ?? []).map((m) => `- missing: ${m}`),
      ].join("\n"),
    );
  } else if (!cmp.hasBaseline) {
    summary = `⚠️ <b>e2e full (k3d)</b> — ${tally} · no baseline`;
  } else {
    // ❌ only when the attributable count clears the suite's own swing — or when the
    // cluster smoke went red, which no amount of browser-story churn excuses.
    const icon =
      cmp.smoke.regressions > 0 || c.new > cmp.noiseFloor
        ? "❌"
        : c.new > 0
          ? "⚠️"
          : cmp.currentFailures.length
            ? "🌗"
            : "✅";
    const badges = [
      cmp.smoke.failed ? `🧪 <b>${cmp.smoke.failed} smoke</b>` : null,
      c.new ? `🆕 <b>${c.new} new</b>` : "🆕 0 new",
      c.broken ? `🔴 ${c.broken} broken` : null,
      c.flaky ? `🌗 ${c.flaky} flaky` : null,
      c.fixed ? `✅ <b>${c.fixed} fixed</b>` : null,
      c.notRun ? `${c.notRun} not run` : null,
    ].filter(Boolean);
    summary = `${icon} <b>e2e full (k3d)</b> — ${tally} · ${badges.join(" · ")}`;
  }

  if (cmp.trustworthy) {
    const table = historyTable(cmp);
    if (table) body.push(table);
    // A single baseline column cannot separate a regression from a flake.
    if (cmp.baselineRuns === 1 && c.new > 0)
      body.push("> ⚠️ Single baseline run — a flake reads as new here.");
  }

  body.push(
    `<sub>Each column is one run of the full suite on the default branch, oldest first; the last is this PR. Rate is failures over the runs that ran the test.` +
      `${cmp.noiseFloor > 0 ? ` The suite's failure count swings by ±${cmp.noiseFloor} between baseline runs with no change between them.` : ""}` +
      `${runUrl ? ` · [run](${runUrl})` : ""}${cmp.hasBaseline ? ` · baseline \`${baselineRef}\`` : ""}</sub>`,
  );

  // The blank line after </summary> is required or GitHub renders the markdown as
  // literal text.
  return `<details><summary>${summary}</summary>\n\n${body.join("\n\n")}\n</details>`;
}

const FLAGS = [
  "baseline",
  "baseline-label",
  "baseline-ref",
  "run-url",
  "expected-shards",
];

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  // The positional report path, skipping every flag and its value.
  let reportPath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (FLAGS.includes(argv[i].slice(2))) i++;
      continue;
    }
    reportPath = argv[i];
    break;
  }
  const read = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };

  const current = read(reportPath);
  if (!current) {
    process.stdout.write(
      "### ⚠️ e2e full (k3d) — no report\n\nThe merged report could not be read, so there is nothing to compare.\n",
    );
    return;
  }
  // --baseline is repeatable: the window is several recent runs.
  const baselines = argv
    .map((a, i) => (a === "--baseline" ? argv[i + 1] : null))
    .filter(Boolean)
    .map(read)
    .filter(Boolean);
  const expected = opt("expected-shards");
  // Positional: the nth --baseline-label names the nth --baseline.
  const runLabels = argv
    .map((a, i) => (a === "--baseline-label" ? argv[i + 1] : null))
    .filter(Boolean);
  const cmp = compare(current, baselines, {
    expectedShards: expected ? Number(expected) : null,
    runLabels: runLabels.length ? runLabels : null,
  });

  process.stdout.write(
    renderMarkdown(cmp, {
      baselineRef: opt("baseline-ref"),
      runUrl: opt("run-url"),
    }) + "\n",
  );

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `new_failures=${cmp.newFailures.length}`,
        `fixed=${cmp.fixed.length}`,
        `still_failing=${cmp.stillFailing.length}`,
        `trustworthy=${cmp.trustworthy}`,
        "",
      ].join("\n"),
    );
  }
}

// Run only as a CLI, so the spec can import the pure functions above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2));
