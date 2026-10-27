/**
 * Tier 1 test for skill delivery to a BYO container. The container cannot read the
 * agent-host pod's filesystem, so skills arrive as data on new_session and are written
 * locally; names become path segments and come off a wire, so the escape guard is part
 * of the contract.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync } from "node:fs";
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
    // These arrive over a wire, so a traversal name must not write outside cwd.
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
  it("an unwritable parent THROWS, so the caller must catch", () => {
    // The target is under the test's own tmpdir rather than /proc, so the failure is a normal filesystem error that fails fast.
    const notADir = join(cwd, "a-file-not-a-dir");
    writeFileSync(notADir, "x", "utf8");
    expect(() => writeSkillPayloads(notADir, [{ name: "a", content: "A" }])).toThrow();
  });
});

describe("pruneSkillDirs", () => {
  /** A `skills-<i>` dir aged `i` minutes, so a higher index is older. */
  const aged = (i: number): string => {
    const p = join(cwd, `skills-${i}`);
    mkdirSync(p);
    const t = new Date(Date.now() - i * 60_000);
    utimesSync(p, t, t);
    return p;
  };

  it("keeps the newest dirs and drops the rest", () => {
    const dirs = [0, 1, 2, 3].map(aged);
    expect(pruneSkillDirs(cwd, 2)).toBe(2);
    expect(dirs.map((d) => existsSync(d))).toEqual([true, true, false, false]);
  });

  it("never drops a dir a live session still reads its skills from", () => {
    const dirs = [0, 1, 2, 3].map(aged);
    pruneSkillDirs(cwd, 2, new Set([dirs[3]]));
    expect(existsSync(dirs[3]), "the oldest dir belongs to a live session").toBe(true);
    expect(existsSync(dirs[2])).toBe(false);
  });
});
