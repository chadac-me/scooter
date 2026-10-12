#!/usr/bin/env node
/**
 * The test inventory: every individual test in the suite, with a selector that addresses
 * it unambiguously. Per-test sharding can lose tests silently (a stale `file:line` or an
 * unescaped regex metacharacter in a --grep matches nothing and exits 0, and duplicate
 * titles make one shard's selection pull another's), so selection is by escaped title,
 * ground truth is `playwright test --list --reporter=json`, and `verify` enforces
 * uniqueness. The cluster inventory keeps both `name` (diagnostics) and the leaf `title`
 * (selection), because vitest's -t matches the leaf only.
 *
 * Usage:
 *   node test/e2e/support/test-inventory.mjs list      # JSON inventory to stdout
 *   node test/e2e/support/test-inventory.mjs verify    # uniqueness + selector round-trip
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

/** Escape every regex metacharacter so a title is matched literally by --grep. */
export function escapeForGrep(title) {
  return title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every test playwright would run for `project`, as { file, line, title, fullTitle, project };
 *  --list loads every spec, so callers should do it once and pass the result around. */
export function inventory({ project } = {}) {
  const args = ["test", "--list", "--reporter=json"];
  if (project) args.push("--project", project);
  const raw = execFileSync(join(REPO_ROOT, "node_modules", ".bin", "playwright"), args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    // E2E_TARGET gates whether the `full` project is defined at all, and an undefined
    // project yields an empty list rather than an error.
    env: project ? { ...process.env, E2E_TARGET: project } : process.env,
    // --list writes the JSON to stdout; warnings go to stderr and are noise here.
    stdio: ["ignore", "pipe", "ignore"],
  });
  const report = JSON.parse(raw);

  const out = [];
  const walk = (node, file, titlePath) => {
    if (!node || typeof node !== "object") return;
    const f = node.file ?? file;
    const path = node.title ? [...titlePath, node.title] : titlePath;
    for (const spec of node.specs ?? []) {
      out.push({
        file: spec.file ?? f,
        line: spec.line,
        title: spec.title,
        // The " › "-joined path playwright prints, kept for diagnostics; selection uses `title`.
        fullTitle: [...path, spec.title].join(" › "),
        project: (spec.tests ?? [])[0]?.projectName ?? null,
      });
    }
    for (const child of node.suites ?? []) walk(child, f, path);
  };
  for (const suite of report.suites ?? []) walk(suite, suite.file, []);
  return out;
}

/** The cluster spec files the e2e-full shards are responsible for: only the smoke pair,
 *  since the rest belong to the separate `cluster image boot` job, and adding a file here
 *  means the shards start running it. */
export const SHARDED_CLUSTER_SPECS = ["platform-smoke", "event-backfill"];

/** Every cluster (vitest) test, as { file, title, name, kind }; RUN_CLUSTER_TESTS=1 is
 *  required (the specs self-skip without it), and `title` is the leaf because vitest's -t
 *  does not match the full "suite > test" path. */
export function clusterInventory() {
  const raw = execFileSync(join(REPO_ROOT, "node_modules", ".bin", "vitest"), ["list", "--project", "cluster", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    env: { ...process.env, RUN_CLUSTER_TESTS: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(raw)
    // Keep only the smoke pair (see SHARDED_CLUSTER_SPECS).
    .filter((t) => SHARDED_CLUSTER_SPECS.some((s) => (t.file ?? "").includes(s)))
    .map((t) => ({
      file: t.file,
      name: t.name,
      title: t.name.split(" > ").pop(),
      kind: "cluster",
    }));
}

/** The combined pool of playwright + cluster tests, each tagged with `kind`; one pool so
 *  the weights balance across both kinds. */
export function combinedInventory() {
  return [
    // --project=full, since the `full` project carries `testMatch: fullSpecs` and a test
    // outside it would run nowhere; E2E_TARGET=full is what makes the project exist.
    ...inventory({ project: "full" }).map((t) => ({ ...t, kind: "e2e" })),
    ...clusterInventory(),
  ];
}

/** Fail loudly on anything that would make title selection lose a test; returns { ok, tests, problems[] }. */
export function verify(tests = inventory()) {
  const problems = [];

  // 1. Duplicate titles, scoped per kind: a playwright --grep only searches playwright
  //    tests and a vitest -t only cluster tests.
  const byTitle = new Map();
  for (const t of tests) {
    const key = `${t.kind ?? "e2e"}\u0000${t.title}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(t);
  }
  for (const [key, group] of byTitle) {
    if (group.length > 1) {
      const [kind, title] = key.split("\u0000");
      problems.push(
        `duplicate ${kind} title (${group.length}x): ${JSON.stringify(title)}\n` +
          group.map((g) => `      ${g.file}${g.line ? `:${g.line}` : ""}`).join("\n"),
      );
    }
  }

  // 2. Empty or whitespace titles cannot be selected at all.
  for (const t of tests) {
    if (!t.title || !t.title.trim()) {
      problems.push(`empty title at ${t.file}${t.line ? `:${t.line}` : ""}`);
    }
  }

  // 3. The escaped title must match the original, which proves the selector we emit
  //    actually selects this test.
  for (const t of tests) {
    if (!t.title) continue;
    let re;
    try {
      re = new RegExp(escapeForGrep(t.title));
    } catch (e) {
      problems.push(`title does not escape to a valid regex at ${t.file}: ${e.message}`);
      continue;
    }
    if (!re.test(t.title)) {
      problems.push(`escaped title does not match itself at ${t.file}: ${JSON.stringify(t.title)}`);
    }
  }

  return { ok: problems.length === 0, tests, problems };
}

function main() {
  const cmd = process.argv[2] ?? "list";
  if (cmd === "list") {
    process.stdout.write(JSON.stringify(combinedInventory(), null, 2));
    return;
  }
  if (cmd === "verify") {
    const { ok, tests, problems } = verify(combinedInventory());
    const e2e = tests.filter((t) => t.kind === "e2e").length;
    const cluster = tests.filter((t) => t.kind === "cluster").length;
    process.stderr.write(`[test-inventory] ${tests.length} tests (${e2e} e2e + ${cluster} cluster)\n`);
    if (!ok) {
      process.stderr.write(
        `[test-inventory] ${problems.length} problem(s) that would LOSE TESTS in a sharded run:\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          "\n",
      );
      process.exit(1);
    }
    process.stderr.write("[test-inventory] ok — every test is uniquely addressable by title\n");
    return;
  }
  process.stderr.write(`unknown command: ${cmd}\nusage: test-inventory.mjs [list|verify]\n`);
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
