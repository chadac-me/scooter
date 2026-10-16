// Covers .github/scripts/flake-focus-pattern.sh — the only parser of the
// focused-flake contract in a PR description. It is exercised as the CI jobs run
// it (PR_BODY in, $GITHUB_OUTPUT out) rather than by reimplementing the parsing,
// since a PR body is attacker-controlled text and its sanitising is the point.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../.github/scripts/flake-focus-pattern.sh", import.meta.url));

/** Run the script on a PR body; returns {ok, outputs, log} with $GITHUB_OUTPUT parsed. */
function run(body, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flake-pat-"));
  const out = join(dir, "github-output");
  writeFileSync(out, "");
  let log = "";
  let ok = true;
  try {
    log = execFileSync("bash", [script], {
      env: { ...process.env, PR_BODY: body, GITHUB_OUTPUT: out, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    ok = false;
    log = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const outputs = Object.fromEntries(
    readFileSync(out, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { ok, outputs, log };
}

const FULL = { FULL_TARGET: "1" };
// On the full-target allowlist (test/e2e/full-specs.json), so it survives the
// intersection; `approval-gate.spec.ts` is fast-only and does not.
const ALLOWED = "test/e2e/stop-run.spec.ts";

describe("the required pattern", () => {
  it("extracts `flake-test:` and strips wrapping backticks", () => {
    const { ok, outputs } = run("some prose\nflake-test: `THREE messages sent mid-run`\nmore");
    expect(ok).toBe(true);
    expect(outputs.pattern).toBe("THREE messages sent mid-run");
  });

  // GitHub delivers PR bodies with CRLF line endings, so a trailing \r must not end
  // up inside a pattern, a spec path or a number.
  it("survives the CRLF line endings a real PR body arrives with", () => {
    const { ok, outputs } = run(
      `flake-test: a test\r\nflake-specs: ${ALLOWED}\r\nflake-repeat: 12\r\nflake-mode: contention\r\n`,
    );
    expect(ok).toBe(true);
    expect(outputs.pattern).toBe("a test");
    expect(outputs.specs_run).toBe(ALLOWED);
    expect(outputs.repeat).toBe("12");
    expect(outputs.mode).toBe("contention");
  });

  it("fails loudly when the label is set but the body names no test", () => {
    const { ok, log } = run("a PR with no flake metadata at all");
    expect(ok).toBe(false);
    expect(log).toContain("has no");
  });
});

describe("mode and specs", () => {
  it("infers targeted with no `flake-specs:`, at the fast default of 20", () => {
    const { outputs } = run("flake-test: a test");
    expect(outputs.mode).toBe("targeted");
    expect(outputs.specs_run).toBe("");
    expect(outputs.repeat).toBe("20");
  });

  it("infers contention from `flake-specs:`, at the smaller contention default", () => {
    const { outputs } = run(`flake-test: a test\nflake-specs: ${ALLOWED} test/e2e/interrupt.spec.ts`);
    expect(outputs.mode).toBe("contention");
    expect(outputs.specs_run).toBe(`${ALLOWED} test/e2e/interrupt.spec.ts`);
    expect(outputs.repeat).toBe("5");
  });

  // The trap this knob exists for: naming specs used to be the only way to ask
  // for contention and silently bought the smaller budget.
  it("lets `flake-mode: targeted` keep the specs line but run the test alone at the targeted budget", () => {
    const { outputs } = run(`flake-test: a test\nflake-specs: ${ALLOWED}\nflake-mode: targeted`);
    expect(outputs.mode).toBe("targeted");
    expect(outputs.specs).toBe(ALLOWED); // still reported
    expect(outputs.specs_run).toBe(""); // but not run
    expect(outputs.repeat).toBe("20");
  });

  it("rejects `flake-mode: contention` with nothing to run together", () => {
    const { ok, log } = run("flake-test: a test\nflake-mode: contention");
    expect(ok).toBe(false);
    expect(log).toContain("needs a 'flake-specs:");
  });

  it("rejects an unknown mode rather than guessing", () => {
    const { ok, log } = run("flake-test: a test\nflake-mode: parallel");
    expect(ok).toBe(false);
    expect(log).toContain("not valid");
  });

  it("drops non-spec tokens so a PR body cannot inject shell args", () => {
    const { outputs, log } = run(`flake-test: a test\nflake-specs: ${ALLOWED} --workers=8 ; rm -rf /`);
    expect(outputs.specs).toBe(ALLOWED);
    expect(log).toContain("ignoring non-spec flake-specs token");
  });
});

describe("the full target", () => {
  it("uses the smaller full defaults", () => {
    expect(run("flake-test: a test", FULL).outputs.repeat).toBe("5");
    expect(run(`flake-test: a test\nflake-specs: ${ALLOWED}`, FULL).outputs.repeat).toBe("3");
  });

  it("intersects `flake-specs:` with the allowlist and fails when nothing is left", () => {
    const { ok, log } = run("flake-test: a test\nflake-specs: test/e2e/approval-gate.spec.ts", FULL);
    expect(ok).toBe(false);
    expect(log).toContain("full-specs.json");
  });

  // Same body, fast job: the fast target has no allowlist, so it still runs.
  it("does not apply the allowlist to the fast job", () => {
    const { ok, outputs } = run("flake-test: a test\nflake-specs: test/e2e/approval-gate.spec.ts");
    expect(ok).toBe(true);
    expect(outputs.specs_run).toBe("test/e2e/approval-gate.spec.ts");
  });
});

describe("the repetition budget", () => {
  it("takes the fast override from `flake-repeat:`", () => {
    expect(run("flake-test: a test\nflake-repeat: 60").outputs.repeat).toBe("60");
  });

  it("takes the full override from `flake-full-repeat:`", () => {
    expect(run("flake-test: a test\nflake-full-repeat: 14", FULL).outputs.repeat).toBe("14");
  });

  // Per-target keys: a repetition on the fast stack is a browser against fakes, a
  // full one is a real sandbox pod, so neither number may leak into the other job.
  it("keeps the two keys on their own targets", () => {
    const body = "flake-test: a test\nflake-repeat: 60\nflake-full-repeat: 14";
    expect(run(body).outputs.repeat).toBe("60");
    expect(run(body, FULL).outputs.repeat).toBe("14");
  });

  it("does not let `flake-full-repeat:` be read as `flake-repeat:`", () => {
    expect(run("flake-test: a test\nflake-full-repeat: 14").outputs.repeat).toBe("20");
  });

  it("overrides the contention default too", () => {
    const { outputs } = run(`flake-test: a test\nflake-specs: ${ALLOWED}\nflake-repeat: 12`);
    expect(outputs.mode).toBe("contention");
    expect(outputs.repeat).toBe("12");
  });

  it.each([
    ["eight", "not a positive integer"],
    ["0", "not a positive integer"],
    ["-3", "not a positive integer"],
    ["101", "exceeds the cap"],
  ])("rejects `flake-repeat: %s`", (value, message) => {
    const { ok, log } = run(`flake-test: a test\nflake-repeat: ${value}`);
    expect(ok).toBe(false);
    expect(log).toContain(message);
  });

  it("caps the full target far lower, since each repetition is a sandbox pod", () => {
    expect(run("flake-test: a test\nflake-full-repeat: 20", FULL).ok).toBe(true);
    expect(run("flake-test: a test\nflake-full-repeat: 21", FULL).ok).toBe(false);
  });
});
