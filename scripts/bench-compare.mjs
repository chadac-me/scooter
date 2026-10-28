#!/usr/bin/env node
// Picks touched benchmark suites and renders PR-vs-base results; dependency-free.
// Usage: select --changed <file> | compare <rounds.jsonl> [--base-ref <sha>]

import { appendFileSync, readFileSync } from "node:fs";

const REGISTRY = ".github/benchmarks.yml";
const BOOTSTRAP = 2000;

/** The registry's suites, from the YAML subset ci-report.mjs reads. */
export function parseRegistry(text) {
  const suites = [];
  let cur = null;
  let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/\s+$/, "");
    if (!line || /^\s*#/.test(line) || /^suites:\s*$/.test(line)) continue;
    const item = line.match(/^ {2}- (\w+):\s*(.*)$/);
    const kv = line.match(/^ {4}(\w+):\s*(.*)$/);
    const entry = line.match(/^ {6}- (.+)$/);
    if (item) {
      cur = { [item[1]]: item[2], paths: [] };
      suites.push(cur);
      list = null;
    } else if (kv && cur) {
      if (kv[2] === "") list = cur[kv[1]] = [];
      else cur[kv[1]] = kv[2];
    } else if (entry && list) {
      list.push(entry[1]);
    } else {
      throw new Error(`benchmarks.yml: cannot parse line: ${raw}`);
    }
  }
  for (const s of suites) {
    for (const k of ["id", "app", "src"])
      if (!s[k]) throw new Error(`benchmarks.yml: a suite has no ${k}`);
    s.noise = Number(s.noise ?? 5);
  }
  return suites;
}

/** A path glob as a regex; only `**` crosses directories. */
export function globRegex(glob) {
  const re = glob
    .split(/(\*\*\/?|\*)/)
    .map((part) =>
      part.startsWith("**")
        ? ".*"
        : part === "*"
          ? "[^/]*"
          : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${re}$`);
}

/** The suites with a path some changed file matches. */
export function selectSuites(suites, changed) {
  return suites.filter((s) =>
    s.paths.some((g) => changed.some((f) => globRegex(g).test(f))),
  );
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Seeded, so a report is reproducible from its rounds. */
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 95% bootstrap interval on median(pr) / median(base). */
export function ratioInterval(base, pr, rand = mulberry32(1)) {
  const draw = (xs) => xs.map(() => xs[Math.floor(rand() * xs.length)]);
  const ratios = [];
  for (let i = 0; i < BOOTSTRAP; i++) {
    const b = median(draw(base));
    if (b > 0) ratios.push(median(draw(pr)) / b);
  }
  ratios.sort((a, b) => a - b);
  const at = (q) => ratios[Math.min(ratios.length - 1, Math.floor(q * ratios.length))];
  return [at(0.025), at(0.975)];
}

/** A change counts only when its whole interval clears the floor. */
export function compare(lines, suites) {
  const noise = Object.fromEntries(suites.map((s) => [s.id, s.noise]));
  const failed = new Set();
  const cases = new Map();
  for (const l of lines) {
    if (l.failed) {
      failed.add(`${l.suite}/${l.side}`);
      continue;
    }
    const key = `${l.suite}\u0000${l.case}\u0000${l.unit}`;
    if (!cases.has(key))
      cases.set(key, { suite: l.suite, case: l.case, unit: l.unit, base: [], pr: [] });
    cases.get(key)[l.side]?.push(l.value);
  }
  const rows = [];
  for (const c of cases.values()) {
    const floor = (noise[c.suite] ?? 5) / 100;
    const row = {
      suite: c.suite,
      case: c.case,
      unit: c.unit,
      rounds: Math.min(c.base.length, c.pr.length),
      base: c.base.length ? median(c.base) : null,
      pr: c.pr.length ? median(c.pr) : null,
      interval: null,
      verdict: "new",
    };
    if (row.base != null && row.pr != null && row.base > 0) {
      row.change = row.pr / row.base - 1;
      if (row.rounds >= 3) {
        row.interval = ratioInterval(c.base, c.pr);
        const [lo, hi] = row.interval;
        row.verdict = lo > 1 + floor ? "slower" : hi < 1 - floor ? "faster" : "same";
      } else {
        row.verdict = "few";
      }
    } else if (row.pr == null) {
      row.verdict = "gone";
    }
    rows.push(row);
  }
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  return {
    rows,
    failed: [...failed],
    slower: count("slower"),
    faster: count("faster"),
  };
}

const ms = (v) => (v == null ? "·" : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const pct = (r) => `${r >= 0 ? "+" : ""}${(100 * r).toFixed(0)}%`;
const BADGE = {
  slower: "⚠️ slower",
  faster: "🚀 faster",
  same: "within noise",
  few: "too few rounds",
  new: "new case",
  gone: "missing on PR",
};

/** The status, summary and markdown body for the bench section. */
export function render(cmp, opts = {}) {
  const prFailed = cmp.failed.filter((f) => f.endsWith("/pr"));
  const status = prFailed.length ? "fail" : cmp.slower ? "warn" : "pass";
  const parts = [];
  if (cmp.faster) parts.push(`${cmp.faster} faster`);
  if (cmp.slower) parts.push(`${cmp.slower} slower`);
  if (prFailed.length) parts.push(`${prFailed.length} suite(s) FAILED`);
  const summary = `benchmarks — ${parts.length ? parts.join(", ") : "no change beyond noise"}`;

  const body = [];
  const vs = opts.baseRef ? ` vs merge base \`${opts.baseRef.slice(0, 8)}\`` : " vs merge base";
  body.push(`PR${vs}, interleaved on one runner. Medians over rounds; a case counts as changed only when its 95% bootstrap interval clears the suite's noise floor.`);
  body.push(
    [
      "| suite | case | unit | base | PR | change | 95% interval | |",
      "|---|---|---|--:|--:|--:|---|---|",
      ...cmp.rows.map(
        (r) =>
          `| ${r.suite} | ${r.case} | ${r.unit} | ${ms(r.base)} | ${ms(r.pr)} | ${r.change == null ? "·" : pct(r.change)} | ${
            r.interval ? `${pct(r.interval[0] - 1)} … ${pct(r.interval[1] - 1)}` : "·"
          } | ${BADGE[r.verdict]} |`,
      ),
    ].join("\n"),
  );
  for (const f of cmp.failed) {
    const [suite, side] = f.split("/");
    body.push(
      side === "pr"
        ? `❌ \`${suite}\` failed to run on the PR; see the job log.`
        : `\`${suite}\` did not run on the merge base (new suite, or the harness needs code the base lacks), so its cases have no baseline.`,
    );
  }
  return { status, summary, body: body.join("\n\n") };
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const suites = parseRegistry(readFileSync(opt("registry") ?? REGISTRY, "utf8"));
  if (argv[0] === "select") {
    const changed = readFileSync(opt("changed"), "utf8").split("\n").filter(Boolean);
    for (const s of selectSuites(suites, changed))
      process.stdout.write(`${s.id} ${s.app} ${s.src} ${s.noise}\n`);
    return;
  }
  if (argv[0] === "compare") {
    const lines = readFileSync(argv[1], "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const out = render(compare(lines, suites), { baseRef: opt("base-ref") });
    process.stdout.write(out.body + "\n");
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `status=${out.status}\nsummary=${out.summary}\n`);
    return;
  }
  throw new Error("usage: bench-compare.mjs select|compare ...");
}

// CLI only when run directly, so the spec can import.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2));
