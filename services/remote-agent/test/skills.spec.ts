/**
 * Tier 1 — skill delivery to a BYO container.
 *
 * The container cannot read the agent-host pod's filesystem, so skills arrive as
 * DATA on new_session and are written locally. Names become PATH SEGMENTS and
 * come off a wire, so the escape guard is part of the contract.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pruneSkillDirs, writeSkillPayloads } from "../src/skills.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "byoc-skills-")); });
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("writeSkillPayloads", () => {
  it("writes .claude/skills/<name>/SKILL.md, the layout the SDK discovers", () => {
    const n = writeSkillPayloads(cwd, [
      { name: "scooter-github", content: "---\nname: scooter-github\ndescription: d\n---\n\nUse agent-broker.\n" },
    ]);
    expect(n).toBe(1);
    const p = join(cwd, ".claude", "skills", "scooter-github", "SKILL.md");
    expect(existsSync(p)).toBe(true);
    const t = readFileSync(p, "utf8");
    // The frontmatter must survive: the SDK reads `description` from it.
    expect(t).toMatch(/^---/);
    expect(t).toContain("description:");
    expect(t).toContain("Use agent-broker.");
  });

  it("writes every skill it is given", () => {
    const n = writeSkillPayloads(cwd, [
      { name: "a", content: "A" },
      { name: "b", content: "B" },
      { name: "c", content: "C" },
    ]);
    expect(n).toBe(3);
    for (const name of ["a", "b", "c"]) {
      expect(existsSync(join(cwd, ".claude", "skills", name, "SKILL.md"))).toBe(true);
    }
  });

  it("REFUSES a name that would escape the skills directory", () => {
    // These arrive over a wire. A traversal name must not write outside cwd.
    const n = writeSkillPayloads(cwd, [
      { name: "../../../etc/evil", content: "x" },
      { name: "..", content: "x" },
      { name: "a/b", content: "x" },
      { name: ".hidden", content: "x" },
      { name: "ok", content: "fine" },
    ]);
    expect(n).toBe(1);
    expect(existsSync(join(cwd, ".claude", "skills", "ok", "SKILL.md"))).toBe(true);
    // nothing landed above the skills dir
    expect(existsSync(join(cwd, "..", "etc"))).toBe(false);
  });

  it("no skills -> 0, and no directory is created", () => {
    expect(writeSkillPayloads(cwd, [])).toBe(0);
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
  });
});
describe("failure is survivable", () => {
  it("an unwritable parent THROWS from the writer, so the caller must catch", () => {
    // The caller wraps this in try/catch: skills are an enhancement, and the
    // first version let ENOENT propagate so every BYOC run died with
    // "no such file or directory, mkdtemp '/tmp/scooter-skills-XXXXXX'".
    // This pins that the writer itself is allowed to throw.
    expect(() =>
      writeSkillPayloads("/proc/nonexistent-and-unwritable", [{ name: "a", content: "A" }]),
    ).toThrow();
  });
});
describe("pruneSkillDirs — the volume is persistent", () => {
  /** Make `n` skills-<i> dirs, oldest first by mtime. */
  function seed(parent: string, n: number): string[] {
    const made: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const p = join(parent, `skills-${i}`);
      mkdirSync(p, { recursive: true });
      const t = new Date(Date.now() - (n - i) * 60_000);
      utimesSync(p, t, t);
      made.push(p);
    }
    return made;
  }

  it("keeps the newest N and removes the rest", () => {
    const dirs = seed(cwd, 8);
    expect(pruneSkillDirs(cwd, 3)).toBe(5);
    // the 3 newest survive
    for (const p of dirs.slice(-3)) expect(existsSync(p)).toBe(true);
    for (const p of dirs.slice(0, 5)) expect(existsSync(p)).toBe(false);
  });

  it("keeps everything when under the limit", () => {
    const dirs = seed(cwd, 2);
    expect(pruneSkillDirs(cwd, 5)).toBe(0);
    for (const p of dirs) expect(existsSync(p)).toBe(true);
  });

  it("ignores unrelated directories", () => {
    mkdirSync(join(cwd, "projects"), { recursive: true });
    seed(cwd, 4);
    pruneSkillDirs(cwd, 1);
    expect(existsSync(join(cwd, "projects"))).toBe(true);
  });

  it("a missing parent is not an error — it must never break a session", () => {
    expect(pruneSkillDirs(join(cwd, "nope"), 3)).toBe(0);
  });
});


