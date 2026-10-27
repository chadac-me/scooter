/**
 * Skills + agent identity -> a prompt, per provider.
 *
 * goose reads `.goosehints` from its cwd with every skill body inlined, while the
 * claude SDK takes a `systemPrompt` string and discovers skills itself from
 * `.claude/skills/<name>/SKILL.md`, so its prompt carries no skill bodies.
 * Provider-specific text lives in gooseAddendum/sdkAddendum, never in identityCore.
 * Skills are read from a directory at runtime (a ConfigMap mount in cluster, a local
 * dir in dev), so adding or editing one needs no image rebuild. The conversation
 * owner's PERSONAL skills (userSkillStore) are merged over that directory before any
 * provider sees them, so both halves travel every path identically.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface AgentIdentity {
  /** Display name the agent goes by. */
  name: string;
  /** Optional extra persona/behavior lines appended to the base prompt. */
  persona?: string;
}

const DEFAULT_IDENTITY: AgentIdentity = { name: "Scooter" };

/** Provider-neutral identity and behaviour, which must not name a tool only one provider has. */
export function identityCore(id: AgentIdentity = DEFAULT_IDENTITY): string {
  return [
    `You are ${id.name}, an AI coding agent.`,
    `Refer to yourself as ${id.name}. When asked your name, say you are ${id.name}.`,
    `You work inside a per-conversation Nix sandbox: a Linux environment where`,
    `your shell commands run. Packages are managed with Nix. Be concise and act`,
    `directly — run commands to inspect and change the workspace rather than`,
    `guessing.`,
    // Runaway-command guardrail, since a recursive search of /nix/store never finishes.
    `Your work lives under \`/workspace\`. NEVER search the whole filesystem`,
    `(\`grep -r … /\`, \`find / …\`) — /nix/store is huge and the command will be`,
    `killed at a ~5min timeout. Scope searches to \`/workspace\` (or a specific`,
    `repo).`,
    // Conversation titling: the host extracts a <title>…</title> marker from the
    // very start of your reply and uses it to name the conversation.
    `At the very START of your FIRST reply in a conversation, emit a concise`,
    `(3–6 word) title for the task wrapped in a <title> tag, e.g.`,
    `"<title>Fix the login redirect</title>". Put it before anything else and do`,
    `it only once, on the first reply. The tag is hidden from the user.`,
    // The marker is accepted once, so a deliberate later rename needs the tool.
    `Later in a conversation the marker is ignored: to rename a conversation whose`,
    `subject has really changed, call the \`set_conversation_title\` tool.`,
    id.persona ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** goose-only caveats (the tools that read the wrong filesystem, run_background), appended to identityCore for the goose path only. */
export function gooseAddendum(): string {
  return [
    // Only the developer extension's read/write/edit/shell tools run in the sandbox, while
    // `tree` and `read_image` read the host's filesystem.
    `IMPORTANT: do NOT use the \`tree\` or \`read_image\` tools — they read a`,
    `different machine's filesystem, not your sandbox, so their results are wrong.`,
    `To list or explore directories, use the \`shell\` tool with \`ls\`, \`ls -R\`,`,
    `or \`find\` instead — those run in your sandbox and see the real workspace.`,
    `To look at an image in your sandbox (e.g. a screenshot you took), use the`,
    `\`view_image\` tool instead of \`read_image\`.`,
    `For a long job (a build, a test suite), use the \`run_background\` tool so it`,
    `doesn't block your turn or hit the timeout.`,
  ].join("\n");
}

/** The claude-SDK-only preamble, telling the model what a system reminder is since a custom systemPrompt replaces the whole claude_code preset. */
export function sdkAddendum(): string {
  return [
    // Without this nothing tells the model that CLAUDE.md content, hook output and the
    // skill list are application context rather than user speech.
    `The application adds system reminders to this conversation. Treat them as`,
    `context from the application, not as messages from the user.`,
    // Skills arrive as name + description; the body loads on demand.
    `Your available skills are listed as system reminders. When a task falls in a`,
    `skill's area, read that skill BEFORE acting — it is authoritative for this`,
    `environment and overrides your general assumptions.`,
  ].join("\n");
}

/** goose's full prompt: core + its addendum. */
export function goosePrompt(id: AgentIdentity = DEFAULT_IDENTITY): string {
  return `${identityCore(id)}\n${gooseAddendum()}`;
}

/** The SDK's full prompt, core plus its addendum, carrying no skill bodies. */
export function sdkPrompt(id: AgentIdentity = DEFAULT_IDENTITY): string {
  return `${identityCore(id)}\n${sdkAddendum()}`;
}

/** @deprecated goose-shaped alias, kept so existing callers/tests still build. */
export function identityPrompt(id: AgentIdentity = DEFAULT_IDENTITY): string {
  return goosePrompt(id);
}

/** A loaded skill: its name, parsed frontmatter, and markdown. */
export interface Skill {
  /** Directory-safe name, from the filename. */
  name: string;
  /** Full file text, frontmatter included. */
  text: string;
  /** What the SDK matches on to decide a skill is relevant: frontmatter `description`, else
   *  `triggers` folded into a sentence, else the first prose line, never empty since the SDK
   *  drops a skill with no description. */
  description: string;
}

/** Read every `*.md` skill from `dir` sorted by name, or [] for a missing dir. */
export function loadSkills(dir: string): Skill[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const name = f.replace(/\.md$/, "");
      const text = readFileSync(join(dir, f), "utf8");
      return { name, text, description: skillDescription(name, text) };
    });
}

// --- personal skills -------------------------------------------------------
// A user's own skills, authored in the settings page and stored per owner, merged
// into the deployment's before any provider sees them. Budgets exist because the
// goose path inlines every body into .goosehints verbatim.

/** Longest a single personal skill body may be. */
export const MAX_PERSONAL_SKILL_BYTES = 32 * 1024;
/** Most personal skills one owner may keep. */
export const MAX_PERSONAL_SKILLS = 50;
/** Total body budget per owner, the limit that actually bounds the prompt. */
export const MAX_PERSONAL_TOTAL_BYTES = 128 * 1024;
/** A name is the agent-visible filename, so it must be a safe single path segment. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A personal skill as the user authored it. */
export interface PersonalSkillInput {
  name: string;
  description: string;
  body: string;
}

/** Shape a stored row as a `Skill` so it merges with the directory-loaded ones. */
export function personalSkill(row: PersonalSkillInput): Skill {
  const description = row.description.trim() || skillDescription(row.name, row.body);
  return { name: row.name, text: row.body, description };
}

/** Deployment skills plus personal ones, name-sorted, a personal skill replacing a deployment skill of the same name. */
export function mergeSkills(base: readonly Skill[], personal: readonly Skill[]): Skill[] {
  const by = new Map(base.map((s) => [s.name, s]));
  for (const s of personal) by.set(s.name, s);
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The deployment skill names a personal skill is replacing, for the UI's warning and the host's log. */
export function shadowedNames(base: readonly Skill[], personal: readonly Skill[]): string[] {
  const names = new Set(base.map((s) => s.name));
  return personal.filter((s) => names.has(s.name)).map((s) => s.name).sort();
}

/** The reason a skill is invalid, or null when it is fine; the message goes to the settings form. */
export function validateSkillInput(row: PersonalSkillInput): string | null {
  if (!SKILL_NAME_RE.test(row.name)) {
    return "name must be lowercase letters, digits and dashes, start with a letter or digit, and be at most 64 characters";
  }
  if (!row.description.trim()) {
    // The SDK drops a skill whose frontmatter has no description, so it would vanish silently.
    return "description is required — it is what the agent matches on to decide the skill applies";
  }
  if (!row.body.trim()) return "body is required";
  if (Buffer.byteLength(row.body, "utf8") > MAX_PERSONAL_SKILL_BYTES) {
    return `body must be at most ${MAX_PERSONAL_SKILL_BYTES} bytes`;
  }
  return null;
}

/**
 * Whether one owner can afford `incomingBody` on top of `others` (their OTHER skills —
 * the row being replaced is excluded by the caller), or the reason they cannot.
 *
 * Enabled and disabled alike count: a disabled skill is one toggle away from the prompt,
 * so a budget that ignored them would be enforced at the worst possible moment.
 */
export function checkPersonalBudget(
  others: ReadonlyArray<{ body: string }>,
  incomingBody: string,
): string | null {
  if (others.length + 1 > MAX_PERSONAL_SKILLS) {
    return `at most ${MAX_PERSONAL_SKILLS} skills per user`;
  }
  const used = others.reduce((n, s) => n + Buffer.byteLength(s.body, "utf8"), 0);
  const total = used + Buffer.byteLength(incomingBody, "utf8");
  if (total > MAX_PERSONAL_TOTAL_BYTES) {
    return `your skills would total ${total} bytes, over the ${MAX_PERSONAL_TOTAL_BYTES}-byte budget — shorten or delete one`;
  }
  return null;
}

/** Assemble the full `.goosehints` content: identity + each skill's body. */
export function assembleHints(skills: Skill[], identity: AgentIdentity = DEFAULT_IDENTITY): string {
  const parts = [identityPrompt(identity)];
  if (skills.length) {
    parts.push("\n# Skills\n\nThe following skills give you knowledge and instructions for this environment.\n");
    for (const s of skills) parts.push(stripFrontmatter(s.text).trim());
  }
  return parts.join("\n\n") + "\n";
}

/** Write the conversation's `.goosehints` into `cwd`, returning the number of skills included. */
export function writeHints(
  cwd: string,
  skillsDir: string,
  identity: AgentIdentity = DEFAULT_IDENTITY,
  personal: readonly Skill[] = [],
): number {
  const skills = mergeSkills(loadSkills(skillsDir), personal);
  writeFileSync(join(cwd, ".goosehints"), assembleHints(skills, identity), "utf8");
  return skills.length;
}

/** A skill as it travels to a BYO container: name + the rendered SKILL.md. */
export interface SkillPayload {
  name: string;
  /** The full SKILL.md text, frontmatter included. */
  content: string;
}

/** The skills to send a BYO container, which has no access to this pod's filesystem and writes them itself (writeSkillPayloads) for its own SDK to discover. */
export function skillPayloads(skillsDir: string, personal: readonly Skill[] = []): SkillPayload[] {
  return mergeSkills(loadSkills(skillsDir), personal).map((s) => ({ name: s.name, content: renderSkillFile(s) }));
}

/** A stable hash of a skill set, to detect stale sessions. */
export function skillsFingerprint(skills: readonly SkillPayload[]): string {
  return createHash("sha256").update(JSON.stringify(skills.map((s) => [s.name, s.content]))).digest("hex");
}

/** Write received payloads as `.claude/skills/<name>/SKILL.md` under `cwd`, the container-side counterpart of writeSkillDir, returning the number written. */
export function writeSkillPayloads(cwd: string, skills: readonly SkillPayload[]): number {
  if (!skills.length) return 0;
  const base = join(cwd, ".claude", "skills");
  for (const s of skills) {
    // A hostile/garbled name must not escape the skills dir.
    if (!/^[A-Za-z0-9._-]+$/.test(s.name) || s.name.startsWith(".")) continue;
    const dir = join(base, s.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), s.content, "utf8");
  }
  return skills.length;
}

/** Materialise `.claude/skills/<name>/SKILL.md` under `cwd` for the SDK to discover, returning the number of skills written. */
export function writeSkillDir(
  cwd: string,
  skillsDir: string,
  personal: readonly Skill[] = [],
): number {
  const skills = mergeSkills(loadSkills(skillsDir), personal);
  const base = join(cwd, ".claude", "skills");
  // A retired skill must not stay discoverable.
  rmSync(base, { recursive: true, force: true });
  if (!skills.length) return 0;
  for (const s of skills) {
    const dir = join(base, s.name);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, "SKILL.md");
    rmSync(dest, { force: true });
    // A written file with rewritten frontmatter, since the SDK parses `description` from the
    // file it finds and our skills carry `triggers:` instead.
    writeFileSync(dest, renderSkillFile(s), "utf8");
  }
  return skills.length;
}

/** The SKILL.md the SDK reads: the computed `description` (carrying the trigger phrases the model matches on) over the original body. */
export function renderSkillFile(s: Skill): string {
  const body = stripFrontmatter(s.text).trim();
  // Only name + description: the SDK needs those two, and the original
  // `triggers:`/`type:`/`version:` fields mean nothing to it.
  return [
    "---",
    `name: ${s.name}`,
    // Single-line, quoted: a stray newline or colon would break the YAML and
    // the SDK drops a skill whose frontmatter does not parse.
    `description: ${JSON.stringify(s.description.replace(/\s+/g, " ").trim())}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/** Parse `name`/`description`/`triggers` out of a skill's frontmatter. */
export function parseFrontmatter(md: string): Record<string, string | string[]> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of m[1].split("\n")) {
    // A `- item` line continues the list opened by the last `key:` with no value.
    const item = raw.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      (out[listKey] as string[]).push(item[1].trim());
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val.trim() === "") {
      listKey = key;
      out[key] = [];
    } else {
      listKey = null;
      out[key] = val.trim();
    }
  }
  return out;
}

/** The description the SDK matches on, never empty since a skill without one is dropped, falling back through triggers to the first prose line to the name. */
function skillDescription(name: string, md: string): string {
  const fm = parseFrontmatter(md);
  const explicit = typeof fm.description === "string" ? fm.description : "";
  if (explicit) return explicit;
  const triggers = Array.isArray(fm.triggers) ? fm.triggers : [];
  // Lead with the H1, then the skill's own opening prose, since the model needs a statement
  // of when the skill applies rather than a keyword list.
  const body = stripFrontmatter(md);
  const heading = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("# "))
    ?.replace(/^#\s*/, "");
  // The first paragraph after the heading: skills open with "Applies when ..."
  // or similar, which is exactly the when-to-use sentence we want.
  const firstPara = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("```"));
  if (heading && firstPara) return `${heading}. ${stripMarkdown(firstPara)}`;
  if (heading && triggers.length) {
    // No usable prose: fall back to triggers, but phrase them as a condition.
    return `${heading}. Use this when the task involves ${triggers.slice(0, 6).join(", ")}.`;
  }
  if (firstPara) return stripMarkdown(firstPara);
  if (heading) return heading;
  const prose = stripFrontmatter(md)
    .split("\n")
    .map((l) => l.trim())
    // Skip headings, fences and blanks to reach the first sentence.
    .find((l) => l && !l.startsWith("#") && !l.startsWith("```"));
  return prose || `The ${name} skill for this environment.`;
}

/** Strip markdown emphasis/links so a description reads as plain prose. */
function stripMarkdown(t: string): string {
  return t
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\([^)]*\)/g, "$1");
}

/** Drop a leading `---\n...\n---` YAML frontmatter block, keeping the body. */
function stripFrontmatter(md: string): string {
  const m = md.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? md.slice(m[0].length) : md;
}
