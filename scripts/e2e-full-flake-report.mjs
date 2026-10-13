#!/usr/bin/env node
// e2e-full-flake-report.mjs — turn the merged Playwright JSON from a `--repeat-each`
// sweep of the full target into a per-test flake rate (see `e2e-full-collect` in
// .github/workflows/ci.yml). One pass of the suite only says which tests were red
// that night; a sweep says how often each one fails, which separates a broken test
// (5/5) from a flake (1/5).
//
// Usage:
//   node scripts/e2e-full-flake-report.mjs <report.json> [options]
//     --repeat <n>          repetitions each test was given, for the short-run check
//     --expected-shards <n> how many shard reports the merge should have seen
//     --history <f>         a merged report from an earlier sweep (repeatable, oldest first)
//     --history-label <l>   column header for the nth --history (repeatable, positional)
//     --run-url <url>       link back to this workflow run
//
// Output: the comment body on stdout; with $GITHUB_OUTPUT set it also writes
// `broken` / `flaky` / `clean` / `runs` / `failures` / `short` / `trustworthy`.

import { readFileSync, appendFileSync } from "node:fs";

import { collectSpecs } from "./flake-focus-report.mjs";

/** The sweep's per-test record: every test that ran, bucketed by how often it failed. */
export function summarizeSweep(report, opts = {}) {
  const repeat = Number(opts.repeat) || 0;
  const expectedShards = opts.expectedShards ?? null;
  const executed = collectSpecs(report ?? {})
    .filter((s) => s.runs > 0)
    .map((s) => ({ ...s, rate: s.failed / s.runs }));

  // Rate first, then the raw failure count, then the title so the table is stable.
  const byRate = (a, b) =>
    b.rate - a.rate || b.failed - a.failed || a.fullTitle.localeCompare(b.fullTitle);

  const broken = executed.filter((s) => s.failed === s.runs).sort(byRate);
  const flaky = executed.filter((s) => s.failed > 0 && s.failed < s.runs).sort(byRate);
  const clean = executed.filter((s) => s.failed === 0);
  // Fewer repetitions than asked for means the shard died mid-sweep, so this test's
  // rate rests on a smaller sample than the rest.
  const short = repeat > 0 ? executed.filter((s) => s.runs < repeat) : [];

  const shardReports = report?.meta?.shardReports;
  const missingShards =
    expectedShards != null && Number.isFinite(shardReports)
      ? Math.max(0, expectedShards - shardReports)
      : 0;

  return {
    repeat,
    executed,
    broken,
    flaky,
    clean,
    short,
    tests: executed.length,
    runs: executed.reduce((n, s) => n + s.runs, 0),
    failures: executed.reduce((n, s) => n + s.failed, 0),
    missingShards,
    // A lost shard omits its tests from the merge, where their absence is silent.
    trustworthy: missingShards === 0 && executed.length > 0,
  };
}

/** Each earlier sweep's rate for one test, oldest first, as `{ label, failed, runs }`. */
export function historyFor(fullTitle, history) {
  return history
    .map(({ label, byTitle }) => {
      const s = byTitle.get(fullTitle);
      return s ? { label, failed: s.failed, runs: s.runs } : { label, failed: null, runs: 0 };
    })
    .filter(Boolean);
}

/** Index earlier sweep reports by test title so a trend column can be rendered. */
export function indexHistory(reports, labels = []) {
  return reports.map((report, i) => ({
    label: labels[i] || `−${reports.length - i}`,
    byTitle: new Map(
      collectSpecs(report)
        .filter((s) => s.runs > 0)
        .map((s) => [s.fullTitle, s]),
    ),
  }));
}

const pct = (x) => `${Math.round(x * 100)}%`;
const rate = (s) => `${s.failed}/${s.runs}`;
const file = (s) => (s.file || "").split("/").pop();

/** `0/5 · 2/5 · –` across the window, oldest first; `–` is a sweep that never ran it. */
function trendCell(s, history) {
  if (!history.length) return "";
  return historyFor(s.fullTitle, history)
    .map((h) => (h.failed === null ? "–" : `${h.failed}/${h.runs}`))
    .join(" · ");
}

function table(rows, history, { withRate }) {
  const head = ["test", "file"];
  if (withRate) head.unshift("rate");
  if (history.length) head.push(`earlier sweeps (${history.map((h) => h.label).join(" · ")})`);
  const align = head.map((h) => (h === "rate" ? "--:" : "---"));
  const L = [`| ${head.join(" | ")} |`, `|${align.join("|")}|`];
  for (const s of rows) {
    const cells = [`\`${s.title}\``, `\`${file(s)}\``];
    if (withRate) cells.unshift(`**${rate(s)}** (${pct(s.rate)})`);
    if (history.length) cells.push(trendCell(s, history) || "–");
    L.push(`| ${cells.join(" | ")} |`);
  }
  return L.join("\n");
}

/** The first failure message from each of the worst offenders, for triage without the trace. */
function excerpts(rows, limit = 8) {
  const shown = rows.slice(0, limit).filter((s) => s.errors.length);
  if (!shown.length) return "";
  const L = ["<details><summary>failure excerpts</summary>", ""];
  for (const s of shown) {
    L.push(`**${s.title}** — ${rate(s)} · \`${file(s)}\``, "", "```", s.errors[0], "```", "");
  }
  L.push("</details>");
  return L.join("\n");
}

export function renderMarkdown(sweep, opts = {}) {
  const { runUrl = "", history = [] } = opts;
  const reps = sweep.repeat ? `×${sweep.repeat}` : "repeated";
  const body = [];

  if (!sweep.executed.length) {
    return [
      `<details><summary>⚠️ <b>e2e full flake sweep</b> — no tests ran</summary>`,
      "",
      `The merged report carries no executed test, so the sweep measured nothing — the shards failed before running the suite.${runUrl ? ` [run](${runUrl})` : ""}`,
      "</details>",
    ].join("\n");
  }

  const icon = sweep.broken.length ? "🔴" : sweep.flaky.length ? "🌗" : "✅";
  const badges = [
    sweep.broken.length ? `🔴 <b>${sweep.broken.length} always red</b>` : null,
    sweep.flaky.length ? `🌗 <b>${sweep.flaky.length} flaky</b>` : null,
    `✅ ${sweep.clean.length} clean`,
    sweep.missingShards ? `⚠️ ${sweep.missingShards} shard report(s) missing` : null,
  ].filter(Boolean);
  const summary = `${icon} <b>e2e full flake sweep</b> — ${sweep.tests} tests ${reps} = ${sweep.runs} runs · ${badges.join(" · ")}`;

  if (sweep.broken.length) {
    body.push(
      [
        `#### 🔴 Always red — ${sweep.broken.length} test(s) failed every repetition`,
        "",
        "These are broken against the current platform, not flaky: no repetition passed.",
        "",
        table(sweep.broken, history, { withRate: false }),
      ].join("\n"),
    );
  }

  if (sweep.flaky.length) {
    body.push(
      [
        `#### 🌗 Flaky — ${sweep.flaky.length} test(s) failed some repetitions`,
        "",
        "Highest rate first; take one to `e2e-full-flake-check` with `flake-test:` set to its title.",
        "",
        table(sweep.flaky, history, { withRate: true }),
      ].join("\n"),
    );
  }

  if (!sweep.broken.length && !sweep.flaky.length) {
    body.push(
      `Every one of the ${sweep.tests} tests passed all ${sweep.repeat || ""} repetitions — ${sweep.runs} runs, no failures.`,
    );
  }

  const ex = excerpts([...sweep.broken, ...sweep.flaky]);
  if (ex) body.push(ex);

  if (sweep.short.length) {
    body.push(
      `> ⚠️ ${sweep.short.length} test(s) ran fewer than ${sweep.repeat} times, so their rates rest on a smaller sample: ` +
        sweep.short
          .slice(0, 10)
          .map((s) => `\`${s.title}\` (${s.runs})`)
          .join(", ") +
        ".",
    );
  }

  if (sweep.missingShards) {
    body.push(
      `> ⚠️ ${sweep.missingShards} shard(s) wrote no report. Their tests are absent from this sweep rather than clean, so the clean count is a floor.`,
    );
  }

  body.push(
    `<sub>Each test ran ${sweep.repeat || "several"}× on its shard's own k3d cluster under \`retries: 0\`, so every repetition is an independent run and the rate is failures over repetitions.` +
      `${history.length ? " Earlier-sweep columns are the same measure from previous runs on the default branch, oldest first." : ""}` +
      `${runUrl ? ` · [run](${runUrl})` : ""}</sub>`,
  );

  // The blank line after </summary> is required or GitHub renders the markdown as
  // literal text.
  return `<details><summary>${summary}</summary>\n\n${body.join("\n\n")}\n</details>`;
}

const FLAGS = ["repeat", "expected-shards", "history", "history-label", "run-url"];

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const all = (name) => argv.map((a, i) => (a === `--${name}` ? argv[i + 1] : null)).filter(Boolean);
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
      "### ⚠️ e2e full flake sweep — no report\n\nThe merged report could not be read, so the sweep measured nothing.\n",
    );
    writeOutputs({ broken: 0, flaky: 0, clean: 0, runs: 0, failures: 0, short: 0, trustworthy: false });
    return;
  }

  // The window is best-effort: an expired artifact just drops a column.
  const history = indexHistory(all("history").map(read).filter(Boolean), all("history-label"));
  const expected = opt("expected-shards");
  const sweep = summarizeSweep(current, {
    repeat: opt("repeat"),
    expectedShards: expected ? Number(expected) : null,
  });

  process.stdout.write(renderMarkdown(sweep, { runUrl: opt("run-url"), history }) + "\n");
  writeOutputs({
    broken: sweep.broken.length,
    flaky: sweep.flaky.length,
    clean: sweep.clean.length,
    runs: sweep.runs,
    failures: sweep.failures,
    short: sweep.short.length,
    trustworthy: sweep.trustworthy,
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
