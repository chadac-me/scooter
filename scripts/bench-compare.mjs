#!/usr/bin/env node
// Picks touched benchmark suites and reports pyperf comparisons; dependency-free.
// Usage: select --changed <file> | report <out-dir> [--base-ref <sha>]

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REGISTRY = ".github/benchmarks.yml";

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

/** Counts faster and slower rows in a compare_to table. */
export function countChanges(table) {
  const rows = table.split("\n").filter((l) => l.startsWith("|") && !/Geometric mean/.test(l));
  const count = (word) => rows.filter((l) => new RegExp(`x ${word}\\s*\\|`).test(l)).length;
  return { faster: count("faster"), slower: count("slower") };
}

/** The bench section from bench-ab.sh's per-suite output files. */
export function report(suites, read, opts = {}) {
  let faster = 0;
  let slower = 0;
  const failed = [];
  const vs = opts.baseRef ? ` vs merge base \`${opts.baseRef.slice(0, 8)}\`` : " vs merge base";
  const body = [
    `PR${vs}, measured with [pyperf](https://pyperf.readthedocs.io/) on one runner. Rows pyperf finds not significant, or under the suite's noise floor, are hidden.`,
  ];
  for (const s of suites) {
    body.push(`#### \`${s.id}\``);
    if (read(`${s.id}.failed`) != null) {
      failed.push(s.id);
      body.push("❌ Failed to run on the PR; see the job log.");
    } else if (read(`${s.id}.nobase`) != null) {
      body.push("No baseline: the suite did not run on the merge base.");
    } else {
      const table = read(`${s.id}.md`) ?? "";
      const c = countChanges(table);
      faster += c.faster;
      slower += c.slower;
      // pyperf heads each column with its file's name.
      const named = table.replace(`${s.id}.base`, "base").replace(`${s.id}.pr`, "PR");
      body.push(named.trim() || "No result.");
    }
  }
  const parts = [];
  if (faster) parts.push(`${faster} faster`);
  if (slower) parts.push(`${slower} slower`);
  if (failed.length) parts.push(`${failed.length} suite(s) FAILED`);
  return {
    status: failed.length ? "fail" : slower ? "warn" : "pass",
    summary: `benchmarks — ${parts.length ? parts.join(", ") : "no change beyond noise"}`,
    body: body.join("\n\n"),
  };
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
  if (argv[0] === "report") {
    const dir = argv[1];
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);
    const ran = new Set((read("suites.txt") ?? "").split("\n").map((l) => l.split(" ")[0]));
    const out = report(suites.filter((s) => ran.has(s.id)), read, { baseRef: opt("base-ref") });
    process.stdout.write(out.body + "\n");
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `status=${out.status}\nsummary=${out.summary}\n`);
    return;
  }
  throw new Error("usage: bench-compare.mjs select|report ...");
}

// CLI only when run directly, so the spec can import.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2));
