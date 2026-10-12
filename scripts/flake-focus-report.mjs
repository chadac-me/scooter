#!/usr/bin/env node
// flake-focus-report.mjs — turn a Playwright JSON report from a `flake focus` CI
// run into the markdown verdict section posted on the PR (see the `flake-focus` /
// `flake-focus-full` jobs in .github/workflows/ci.yml). The exit status alone
// cannot say whether the targeted test passed, failed or ever ran, so the
// `flake-test:` pattern is resolved against the report and the verdict names
// `not-run` explicitly, which the caller turns into a job failure.
//
// Usage:
//   node scripts/flake-focus-report.mjs <report.json> --pattern <p> [options]
//     --pattern <p>      the PR's `flake-test:` line (a playwright -g pattern)
//     --target fast|full
//     --mode targeted|contention
//     --specs "<a> <b>"  the `flake-specs:` files, when mode=contention
//     --run-url <url>    link back to the workflow run
//     --suggest-full     add the full-target nudge on green
//     --baseline <f>     the control run's report (same test, same budget, on the base)
//     --baseline-ref <r> how to name that base in the comment, e.g. `main@abc1234`
//     --history <f>      a nightly e2e-full report (repeatable); --history-label <l> names it
//
// With $GITHUB_OUTPUT set it also writes `verdict`/`runs`/`failed`/`matched` and
// `control`/`base_runs`/`base_failed` there.

import { readFileSync, appendFileSync } from "node:fs";

/** Mirror playwright's `-g` (a case-insensitive regex), falling back to a literal substring match for a malformed pattern. */
export function patternToRegExp(pattern) {
  const delimited = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  try {
    return delimited
      ? new RegExp(delimited[1], delimited[2].includes("i") ? delimited[2] : delimited[2] + "i")
      : new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

const FAILED = new Set(["failed", "timedOut", "interrupted"]);

/**
 * Flatten the report's nested suites into one record per test title; --repeat-each=N
 * emits N sibling `specs` entries with the same title, so aggregating by title is
 * what yields "ran 20×, failed 3".
 */
export function collectSpecs(report) {
  const byTitle = new Map();
  const walk = (suite, titles, file) => {
    const path = suite.title ? [...titles, suite.title] : titles;
    const f = suite.file || file;
    for (const spec of suite.specs || []) {
      const fullTitle = [...path, spec.title || ""].filter(Boolean).join(" › ");
      // Count results, not tests: with retries one repetition can carry several.
      const runs = (spec.tests || [])
        .flatMap((t) => t.results || [])
        .filter((r) => r.status !== "skipped");
      const rec = byTitle.get(fullTitle) ?? {
        file: spec.file || f || "",
        title: spec.title || "",
        fullTitle,
        runs: 0,
        passed: 0,
        failed: 0,
        errors: [],
      };
      rec.runs += runs.length;
      rec.passed += runs.filter((r) => r.status === "passed").length;
      for (const r of runs.filter((r) => FAILED.has(r.status))) {
        rec.failed += 1;
        rec.errors.push(errorText(r));
      }
      byTitle.set(fullTitle, rec);
    }
    for (const child of suite.suites || []) walk(child, path, f);
  };
  for (const suite of report.suites || []) walk(suite, [], suite.file);
  return [...byTitle.values()];
}

function errorText(result) {
  const raw =
    result.error?.message ||
    (result.errors || []).map((e) => e.message).find(Boolean) ||
    `(${result.status} with no error message)`;
  // Strip ANSI so the excerpt renders in a GitHub code fence.
  const clean = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const head = clean.split("\n").slice(0, 4).join("\n");
  return head.length > 600 ? head.slice(0, 600) + "…" : head;
}

/**
 * Resolve the pattern against the report; verdict is `not-run` (the pattern matched
 * no executed test, which the caller fails the job on), `reproduced` (at least one
 * repetition failed) or `fixed` (every repetition passed).
 */
export function summarize(report, pattern) {
  const re = patternToRegExp(pattern);
  const specs = collectSpecs(report);
  const matched = specs.filter((s) => re.test(s.fullTitle) || re.test(s.title));
  const executed = matched.filter((s) => s.runs > 0);
  const runs = executed.reduce((n, s) => n + s.runs, 0);
  const failed = executed.reduce((n, s) => n + s.failed, 0);
  return {
    pattern,
    matched: executed,
    // A matched test that was entirely skipped proves nothing either, so keep it visible.
    matchedButSkipped: matched.filter((s) => s.runs === 0).length,
    executedSpecs: specs.filter((s) => s.runs > 0).length,
    // Failures of other tests get their own section, since they say nothing about the flake.
    others: specs.filter((s) => !matched.includes(s) && s.failed > 0),
    runs,
    failed,
    verdict: runs === 0 ? "not-run" : failed > 0 ? "reproduced" : "fixed",
  };
}

/**
 * The targeted test's record across a window of recent `e2e-full` runs on the
 * default branch. This is prior evidence, not a control, since a nightly's rate
 * includes full-suite contention; `ran` counts only runs that executed the spec,
 * since a lost shard omits its specs from the merge.
 */
export function summarizeHistory(reports, pattern, labels = []) {
  const re = patternToRegExp(pattern);
  const runs = reports.map((report, i) => {
    const matched = collectSpecs(report).filter(
      (s) => (re.test(s.fullTitle) || re.test(s.title)) && s.runs > 0,
    );
    return {
      label: labels[i] || `−${reports.length - i}`,
      ran: matched.length > 0,
      failed: matched.some((s) => s.failed > 0),
    };
  });
  const executed = runs.filter((r) => r.ran);
  return {
    runs,
    ran: executed.length,
    failed: executed.filter((r) => r.failed).length,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The control: the same test with the same repetition budget on the PR's base
 * commit, without which "0 failures in 20 runs" is unfalsifiable. kind is `strong`
 * (fired on the base, not here), `inconclusive` (fired on neither), `worse` (failed
 * more here), `weak` (fewer failures here) or `none` (no usable control).
 */
export function compareToBaseline(summary, baseline) {
  if (!baseline || baseline.runs === 0)
    return {
      kind: "none",
      // The base's report says whether the pattern or the control's stack was the problem.
      noneReason: !baseline ? "not-attempted" : baseline.executedSpecs > 0 ? "no-match" : "no-tests",
    };
  const baseRate = baseline.failed / baseline.runs;
  // P(zero failures in `summary.runs` draws) at the base's observed rate; repetitions
  // share a worker, so treat it as an order of magnitude.
  const pAllCleanAtBaseRate = (1 - baseRate) ** summary.runs;
  return {
    kind:
      baseline.failed === 0
        ? "inconclusive"
        : summary.failed > baseline.failed
          ? "worse"
          : summary.failed === 0
            ? "strong"
            : "weak",
    baseRuns: baseline.runs,
    baseFailed: baseline.failed,
    baseRate,
    pAllCleanAtBaseRate,
    // A base that fired rarely (2/20 leaves ~12% odds of 20 clean runs) must not be
    // reported as a behaviour change.
    strength: pAllCleanAtBaseRate <= 0.05 ? "tight" : "loose",
  };
}

const pct = (x) =>
  x >= 0.01 ? `${(x * 100).toFixed(0)}%` : x >= 0.0001 ? `${(x * 100).toFixed(2)}%` : "<0.01%";

export function renderMarkdown(summary, opts = {}) {
  const {
    target = "fast",
    mode = "targeted",
    specs = "",
    runUrl = "",
    suggestFull = false,
    baseline = null,
    baselineRef = "",
    history = null,
    historyRef = "main",
  } = opts;
  const targetLabel = target === "full" ? "full target — real k3d cluster" : "fast target — fake stack";
  const control = compareToBaseline(summary, baseline);
  const baseRefLabel = baselineRef ? ` (\`${baselineRef}\`)` : "";
  // No marker: this body is one section of the shared comment, tagged by
  // scripts/comment-sections.mjs.
  const L = [];

  if (summary.verdict === "not-run") {
    L.push(`### ⚠️ flake focus (${target}) — the targeted test never ran`, "");
    L.push(
      `\`flake-test: ${summary.pattern}\` matched **no executed test**, so this check proves nothing about the flake — it passed by running ${summary.matchedButSkipped > 0 ? "only skipped tests" : "other tests"}.`,
      "",
    );
    // Repetitions are aggregated by title, so 6 tests ×5 is 6 here.
    L.push(
      `- Distinct tests executed in this run: **${summary.executedSpecs}**, none matching the pattern.`,
    );
    if (summary.matchedButSkipped > 0)
      L.push(`- ${plural(summary.matchedButSkipped, "matching test")} was skipped (target gating? \`test.skip\`?).`);
    L.push(
      `- The pattern is a case-insensitive regex matched against \`file › describe › test\`. Fix the \`flake-test:\` line in the PR description so it names a real title.`,
    );
    if (mode === "contention")
      L.push(
        `- This was a contention run over \`${specs}\` — the flaky test must live in one of those files, or it never runs here.`,
      );
  } else if (summary.verdict === "reproduced") {
    L.push(
      `### ❌ flake focus (${target}) — the flake STILL reproduces`,
      "",
      `\`${summary.pattern}\` failed **${summary.failed} of ${plural(summary.runs, "repetition")}**.`,
      "",
    );
  } else if (control.kind === "inconclusive") {
    // Lead with the control's failure rather than a ✅ a reader would take as "fixed".
    L.push(
      `### ⚠️ flake focus (${target}) — clean, but the control did not reproduce either`,
      "",
      `\`${summary.pattern}\` passed **${summary.runs}/${summary.runs}** here — and also passed ${control.baseRuns}/${control.baseRuns} on the base${baseRefLabel}. The flake never fired in this experiment at all, so a clean run is not evidence the fix works.`,
      "",
    );
  } else if (control.kind === "strong") {
    L.push(
      control.strength === "tight"
        ? `### ✅ flake focus (${target}) — fixed: it fires on the base, not here`
        : `### ✅ flake focus (${target}) — clean here, but the control is weak (${control.baseFailed}/${control.baseRuns} on the base)`,
      "",
      `\`${summary.pattern}\` failed **${control.baseFailed}/${control.baseRuns}** on the base${baseRefLabel} and **0/${summary.runs}** on this PR.`,
      "",
    );
  } else {
    L.push(
      `### ✅ flake focus (${target}) — no reproduction in ${plural(summary.runs, "repetition")}`,
      "",
      `\`${summary.pattern}\` passed **${summary.runs}/${summary.runs}**.`,
      "",
    );
  }

  if (summary.matched.length) {
    L.push("", "| targeted test | runs | passed | failed |", "|---|---:|---:|---:|");
    for (const s of summary.matched)
      L.push(`| \`${s.fullTitle}\` | ${s.runs} | ${s.passed} | ${s.failed} |`);
  }

  if (summary.verdict !== "not-run" && control.kind !== "none") {
    L.push(
      "",
      `#### Control — the same test on the base${baseRefLabel}`,
      "",
      "| | repetitions | failures |",
      "|---|---:|---:|",
      `| base${baseRefLabel} | ${control.baseRuns} | ${control.baseFailed} |`,
      `| this PR | ${summary.runs} | ${summary.failed} |`,
      "",
    );
    if (control.kind === "strong")
      L.push(
        control.strength === "tight"
          ? `The flake fires on the base at **${pct(control.baseRate)}** and not at all here. If this branch still flaked at that rate, ${plural(summary.runs, "clean run")} in a row would happen only about **${pct(control.pAllCleanAtBaseRate)}** of the time — so this is a real change in behaviour, bounded rather than proven.`
          : `⚠️ **The control is too weak to conclude much.** The base only failed ${control.baseFailed}/${control.baseRuns} (**${pct(control.baseRate)}**), so even if this branch still flaked at exactly that rate, ${plural(summary.runs, "clean run")} in a row would happen about **${pct(control.pAllCleanAtBaseRate)}** of the time — luck explains this result almost as well as a fix does. Raise the repetition budget until the base fails often enough to make a clean run here meaningful.`,
      );
    else if (control.kind === "inconclusive")
      // The remedy differs by target: a full run is already under the label the fast
      // nudge would name.
      L.push(
        target === "full"
          ? `**The experiment had no power.** The flake did not fire on the base either, so this run cannot distinguish "fixed" from "did not happen to fire". This is already the strongest target there is, so the budget is the only knob left: raise \`FULL_REPEAT_TARGETED\` / \`FULL_REPEAT_CONTENTION\` in the \`flake-focus-full\` job, or add \`flake-specs:\` so the test runs under cross-spec contention rather than alone.`
          : `**The experiment had no power.** The flake did not fire on the base either, so this run cannot distinguish "fixed" from "did not happen to fire". Raise the repetition budget, add \`flake-specs:\` so it runs under contention, or — if it was seen on the nightly \`e2e-full\` — use the \`e2e-full-flake-check\` label, since the fast stack cannot produce those conditions at all.`,
      );
    else if (control.kind === "worse")
      L.push(
        `⚠️ It failed **more** here than on the base. At these sample sizes that is not proof of a regression, but this PR has not fixed the flake.`,
      );
    else
      L.push(
        `It still fails here, though less often than on the base — a rate change, not a fix.`,
      );
  } else if (summary.verdict === "fixed" && baseline) {
    // A control was attempted and yielded nothing to compare against.
    L.push(
      "",
      `#### Control — none`,
      "",
      control.noneReason === "no-tests"
        ? `The control run on the base${baseRefLabel} executed **no tests at all** — its stack failed to start, so this is an infrastructure failure, not a verdict. The clean run above stands alone; see the \`control\` step in the job log.`
        : `The same pattern matched no test that ran on the base${baseRefLabel} (renamed in this PR? added by it?), so there is no baseline rate to compare against and the clean run above stands alone.`,
    );
  }

  // Prior evidence from the nightly window: whether the flake is live on main at all.
  if (history && history.ran > 0) {
    const seq = history.runs
      .map((r) => (!r.ran ? "`–`" : r.failed ? "**F**" : "`·`"))
      .join(" ");
    L.push(
      "",
      `#### On \`${historyRef}\` recently — ${history.failed}/${history.ran} nightly ${history.ran === 1 ? "run" : "runs"}`,
      "",
      `${seq}  <sub>oldest → newest; \`–\` = the spec did not run (lost shard)</sub>`,
      "",
    );
    // A clean control while the nightly still fails the spec is an unrepresentative
    // control, not a fix.
    if (history.failed > 0 && (control.kind === "inconclusive" || control.kind === "none"))
      L.push(
        `⚠️ **This flake is live on \`${historyRef}\` but the control did not reproduce it.** That makes the control unrepresentative of the conditions the flake needs, not the flake fixed. Treat the clean run above as *no reproduction under these conditions* and raise the budget or add \`flake-specs:\` until the control fires too.`,
        "",
      );
    else if (history.failed === 0)
      L.push(
        `The spec passed every nightly in this window, so there is no live reproduction on \`${historyRef}\` to fix — check the flake is not already gone, or that \`flake-test:\` names the right test.`,
        "",
      );
  }

  const failing = summary.matched.filter((s) => s.errors.length);
  if (failing.length) {
    L.push("", "<details><summary>Failure output</summary>", "");
    for (const s of failing) {
      L.push(`**\`${s.fullTitle}\`** — ${plural(s.errors.length, "failed repetition")}`, "", "```");
      // One excerpt per distinct error, so a different error among identical timeouts
      // is visible.
      for (const e of [...new Set(s.errors)].slice(0, 3)) L.push(e, "");
      L.push("```", "");
    }
    L.push("</details>");
  }

  if (summary.others.length) {
    L.push(
      "",
      `<details><summary>⚠️ ${plural(summary.others.length, "other test")} also failed — not the targeted flake</summary>`,
      "",
    );
    for (const s of summary.others.slice(0, 20))
      L.push(`- \`${s.fullTitle}\` — ${plural(s.failed, "failure")}`);
    L.push("", "</details>");
  }

  L.push("", "<sub>");
  L.push(
    `Mode: **${mode === "contention" ? `contention (\`${specs}\`)` : "targeted (`-g`)"}** · ${targetLabel}${runUrl ? ` · [run log & traces](${runUrl})` : ""}`,
  );
  if (summary.verdict === "fixed") {
    L.push(
      `<br>“No reproduction in ${plural(summary.runs, "run")}” is not proof of a fix — it bounds how often the flake can still fire.`,
    );
    if (suggestFull)
      L.push(
        `<br>⚠️ This ran the FAST target, which has no sandbox pods — no cold boots, no node CPU saturation, no provisioning contention, i.e. none of the machinery most nightly \`e2e-full\` flakes live in. If the flake was seen there, a green run here shows no <em>regression</em>; add the <code>e2e-full-flake-check</code> label for evidence it is fixed.`,
      );
  }
  L.push("</sub>", "");
  return L.join("\n");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--suggest-full") out.suggestFull = true;
    // Repeatable: the nightly window is several runs, so these accumulate.
    else if (a === "--history" || a === "--history-label") {
      const k = a === "--history" ? "history" : "historyLabel";
      (out[k] ??= []).push(argv[++i]);
    } else if (a.startsWith("--")) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  const file = args._[0];
  const pattern = args.pattern || "";
  if (!file || !pattern) {
    console.error("usage: flake-focus-report.mjs <report.json> --pattern <p> [--target fast|full] …");
    process.exit(2);
  }

  let summary;
  try {
    summary = summarize(JSON.parse(readFileSync(file, "utf8")), pattern);
  } catch (err) {
    // No readable report means the run died before writing one; say so rather than
    // render a verdict off missing data.
    const body = [
      `### ⚠️ flake focus (${args.target || "fast"}) — no report to summarise`,
      "",
      `The run produced no readable Playwright JSON report (\`${err.message}\`), so whether \`${pattern}\` reproduced is unknown. See the job log${args.runUrl ? ` — [run](${args.runUrl})` : ""}.`,
      "",
    ].join("\n");
    process.stdout.write(body);
    writeOutputs({ verdict: "unknown", runs: 0, failed: 0, matched: 0 });
    return;
  }

  // The control is best-effort: it is expected to fail tests, may not have run, and
  // its report may be missing.
  let baseline = null;
  if (args.baseline) {
    try {
      baseline = summarize(JSON.parse(readFileSync(args.baseline, "utf8")), pattern);
    } catch {
      baseline = { runs: 0, failed: 0, matched: [] };
    }
  }

  // The nightly window is best-effort too.
  let history = null;
  if (args.history?.length) {
    const reports = [];
    const labels = [];
    for (const [i, f] of args.history.entries()) {
      try {
        reports.push(JSON.parse(readFileSync(f, "utf8")));
        labels.push(args.historyLabel?.[i] ?? "");
      } catch {
        // Skip this run rather than the window.
      }
    }
    if (reports.length) history = summarizeHistory(reports, pattern, labels);
  }

  const control = compareToBaseline(summary, baseline);
  process.stdout.write(renderMarkdown(summary, { ...args, baseline, history }));
  writeOutputs({
    verdict: summary.verdict,
    runs: summary.runs,
    failed: summary.failed,
    matched: summary.matched.length,
    control: control.kind,
    base_failed: control.baseFailed ?? 0,
    base_runs: control.baseRuns ?? 0,
    history_runs: history?.ran ?? 0,
    history_failed: history?.failed ?? 0,
  });
}

function writeOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
}

// Run only as a CLI, so the spec can import the pure functions above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
