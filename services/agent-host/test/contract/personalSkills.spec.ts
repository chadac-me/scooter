/**
 * Personal skills merging into the deployment's skills: a user's own markdown reaches
 * the agent by both provider paths (.goosehints bodies, .claude/skills files) exactly
 * as a ConfigMap skill does, and shadows a deployment skill of the same name rather
 * than appearing twice. The validation rules are here too, because they are the only
 * thing standing between a settings form and a 2 MiB system prompt.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  personalSkill,
  mergeSkills,
  shadowedNames,
  validateSkillInput,
  checkPersonalBudget,
  MAX_PERSONAL_SKILLS,
  MAX_PERSONAL_SKILL_BYTES,
  MAX_PERSONAL_TOTAL_BYTES,
  writeHints,
  writeSkillDir,
  skillPayloads,
} from "../../src/agent/skills.js";

let root: string;
let skillsDir: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "personal-skills-"));
  skillsDir = join(root, "skills");
  cwd = join(root, "cwd");
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const row = (over: Partial<{ name: string; description: string; body: string }> = {}) => ({
  name: "my-repo",
  description: "The user's own repo conventions. Use when working in acme/app.",
  body: "Clone github.com/acme/app. Run `make check` before pushing.",
  ...over,
});

describe("personalSkill", () => {
  it("carries the authored description rather than deriving one", () => {
    const s = personalSkill(row());
    expect(s.name).toBe("my-repo");
    expect(s.description).toBe("The user's own repo conventions. Use when working in acme/app.");
    expect(s.text).toContain("Clone github.com/acme/app");
  });

  it("falls back to a derived description when the row has none", () => {
    // Rows predating the column, or an empty string slipping through: the SDK DROPS a
    // skill with no description, so an empty one must never reach it.
    const s = personalSkill(row({ description: "" }));
    expect(s.description).not.toBe("");
  });
});

describe("mergeSkills", () => {
  const base = [
    { name: "nix-packages", text: "deployment body", description: "d" },
    { name: "zebra", text: "z", description: "z" },
  ];

  it("appends personal skills and keeps the list name-sorted", () => {
    const merged = mergeSkills(base, [personalSkill(row())]);
    expect(merged.map((s) => s.name)).toEqual(["my-repo", "nix-packages", "zebra"]);
  });

  it("a personal skill of the same name REPLACES the deployment one, never duplicates it", () => {
    // Two skills with one name would write one file twice on the SDK path and print the
    // body twice on the goose path; the user's own copy is the one they meant.
    const mine = personalSkill(row({ name: "nix-packages", body: "my own packaging notes" }));
    const merged = mergeSkills(base, [mine]);
    expect(merged.map((s) => s.name)).toEqual(["nix-packages", "zebra"]);
    expect(merged.find((s) => s.name === "nix-packages")?.text).toBe("my own packaging notes");
  });

  it("shadowedNames reports the collisions so the UI can warn and the host can log", () => {
    const mine = [personalSkill(row({ name: "nix-packages" })), personalSkill(row({ name: "mine" }))];
    expect(shadowedNames(base, mine)).toEqual(["nix-packages"]);
    expect(shadowedNames(base, [])).toEqual([]);
  });
});

describe("injection through both provider paths", () => {
  it("writeHints inlines a personal body next to the deployment ones", () => {
    writeFileSync(join(skillsDir, "platform.md"), "---\nname: platform\n---\n\nDeployment text.");
    const n = writeHints(cwd, skillsDir, { name: "Scooter" }, [personalSkill(row())]);
    expect(n).toBe(2);
    const hints = readFileSync(join(cwd, ".goosehints"), "utf8");
    expect(hints).toContain("Deployment text.");
    expect(hints).toContain("Clone github.com/acme/app");
  });

  it("writeSkillDir writes a personal skill as its own SKILL.md with the authored description", () => {
    writeFileSync(join(skillsDir, "platform.md"), "---\nname: platform\n---\n\nDeployment text.");
    const n = writeSkillDir(cwd, skillsDir, [personalSkill(row())]);
    expect(n).toBe(2);
    const file = readFileSync(join(cwd, ".claude", "skills", "my-repo", "SKILL.md"), "utf8");
    expect(file).toContain("name: my-repo");
    expect(file).toContain("Use when working in acme/app");
    expect(file).toContain("Clone github.com/acme/app");
  });

  it("skillPayloads ships personal skills to a BYO container too", () => {
    // A bring-your-own-Claude laptop cannot read this pod's ConfigMap, so personal skills
    // must travel as data or they silently apply only to cloud runs.
    writeFileSync(join(skillsDir, "platform.md"), "---\nname: platform\n---\n\nDeployment text.");
    const payloads = skillPayloads(skillsDir, [personalSkill(row())]);
    expect(payloads.map((p) => p.name)).toEqual(["my-repo", "platform"]);
    expect(payloads.find((p) => p.name === "my-repo")?.content).toContain("Clone github.com/acme/app");
  });
});

describe("validateSkillInput", () => {
  const ok = (over = {}) => validateSkillInput(row(over));

  it("accepts a well-formed skill", () => {
    expect(ok()).toBeNull();
  });

  it("rejects a name that is not a safe filename", () => {
    // The name becomes `.claude/skills/<name>/SKILL.md`; `..` or a slash would escape it.
    for (const name of ["../escape", "with/slash", "Upper", "", "has space", ".hidden", "a".repeat(65)]) {
      expect(ok({ name }), `expected ${JSON.stringify(name)} to be rejected`).not.toBeNull();
    }
  });

  it("accepts the kebab-case names the platform's own skills use", () => {
    for (const name of ["nix-packages", "scooter-env", "a", "repo2"]) expect(ok({ name })).toBeNull();
  });

  it("requires a description and a body", () => {
    expect(ok({ description: "" })).not.toBeNull();
    expect(ok({ description: "   " })).not.toBeNull();
    expect(ok({ body: "" })).not.toBeNull();
  });

  it("rejects a body over the per-skill budget", () => {
    // On the goose path every body is inlined verbatim into .goosehints, so an unbounded
    // body is an unbounded system prompt.
    expect(ok({ body: "x".repeat(MAX_PERSONAL_SKILL_BYTES + 1) })).not.toBeNull();
    expect(ok({ body: "x".repeat(MAX_PERSONAL_SKILL_BYTES) })).toBeNull();
  });

  it("budgets are ordered so the total binds before the count does", () => {
    // A user hitting MAX_PERSONAL_SKILLS at full size must still be under the total, or
    // the count limit is decoration and the real failure is a blown context window.
    expect(MAX_PERSONAL_TOTAL_BYTES).toBeLessThan(MAX_PERSONAL_SKILLS * MAX_PERSONAL_SKILL_BYTES);
  });
});

describe("checkPersonalBudget", () => {
  const sized = (n: number, bytes: number) => Array.from({ length: n }, () => ({ body: "x".repeat(bytes) }));

  it("allows a skill that fits", () => {
    expect(checkPersonalBudget(sized(3, 1000), "y".repeat(1000))).toBeNull();
  });

  it("refuses the one that crosses the total-bytes budget", () => {
    const others = sized(4, MAX_PERSONAL_TOTAL_BYTES / 4);
    expect(checkPersonalBudget(others, "y")).not.toBeNull();
  });

  it("refuses the one past the count limit", () => {
    expect(checkPersonalBudget(sized(MAX_PERSONAL_SKILLS, 1), "y")).not.toBeNull();
    expect(checkPersonalBudget(sized(MAX_PERSONAL_SKILLS - 1, 1), "y")).toBeNull();
  });

  it("counts disabled skills too (the caller passes every other row)", () => {
    // A disabled skill is one toggle away from the prompt; excluding it would move the
    // failure to the moment the user turns it on, which is the worst time to find out.
    const others = sized(MAX_PERSONAL_SKILLS, 1);
    expect(checkPersonalBudget(others, "y")).toContain("at most");
  });
});
