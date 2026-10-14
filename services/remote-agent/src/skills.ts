/**
 * Skill delivery, container side. A BYO container cannot read the agent-host pod's
 * filesystem, so the cloud sends each skill as data on `new_session` and this writes it
 * to `<cwd>/.claude/skills/<name>/SKILL.md`, the layout the container's own SDK discovers.
 * This package ships to a user's machine and must not depend on agent-host.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A skill as it arrives over the wire. */
export interface SkillPayload {
  name: string;
  /** The full SKILL.md text, frontmatter included. */
  content: string;
}

/** Write each skill as `<cwd>/.claude/skills/<name>/SKILL.md`, returning how many landed. */
export function writeSkillPayloads(cwd: string, skills: readonly SkillPayload[]): number {
  let n = 0;
  for (const s of skills) {
    // The name becomes a path segment, and it arrives over a wire: reject
    // anything that could escape the skills directory.
    if (!/^[A-Za-z0-9._-]+$/.test(s.name) || s.name.startsWith(".")) continue;
    const dir = join(cwd, ".claude", "skills", s.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), s.content, "utf8");
    n += 1;
  }
  return n;
}

/** Drop all but the `keep` newest `skills-*` dirs under `parent`, best-effort because a failure must never break a session. */
export function pruneSkillDirs(parent: string, keep: number): number {
  let removed = 0;
  try {
    const entries = readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("skills-"))
      .map((e) => {
        const p = join(parent, e.name);
        return { p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const { p } of entries.slice(keep)) {
      try {
        rmSync(p, { recursive: true, force: true });
        removed += 1;
      } catch {
        // A dir we cannot remove is not worth failing a session over.
      }
    }
  } catch {
    // No parent dir yet, or unreadable: nothing to prune.
  }
  return removed;
}
