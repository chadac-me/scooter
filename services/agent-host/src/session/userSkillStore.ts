/**
 * Personal skills on the shared Postgres: the per-user half of the agent's skills,
 * authored in the settings page and injected into that user's conversations next to the
 * deployment's `agent-skills` ConfigMap.
 *
 * Two read paths with deliberately different failure modes. `listEnabled` is on the
 * conversation-start path, so a database error there degrades to the deployment's skills
 * rather than failing the conversation. `list` backs the settings page, where answering
 * "you have no skills" over intact rows invites the user to write them again — so it
 * throws. The table is declared in lib/sql/agent_host/schema.sql; this store never
 * creates it.
 */

import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { checkPersonalBudget, validateSkillInput } from "../agent/skills.js";
import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

const { userSkills } = agent_host;

const log = logger("userSkillStore");

/** One stored personal skill. */
export interface UserSkill {
  id: string;
  owner: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Fields a create accepts; `enabled` defaults to true. */
export interface UserSkillInput {
  name: string;
  description: string;
  body: string;
  enabled?: boolean;
}

export interface UserSkillStore {
  /** Every skill the owner has, enabled or not, name-sorted. Throws on a query failure. */
  list(owner: string): Promise<UserSkill[]>;
  /** The owner's enabled skills, for injection. Answers [] on a query failure. */
  listEnabled(owner: string): Promise<UserSkill[]>;
  create(owner: string, input: UserSkillInput): Promise<UserSkill>;
  patch(owner: string, id: string, patch: Partial<UserSkillInput>): Promise<UserSkill | null>;
  remove(owner: string, id: string): Promise<boolean>;
  close(): Promise<void>;
}

/** A rejected write, which the management API renders as a 400 with this message. */
export class UserSkillError extends Error {}

export interface PgUserSkillStoreConfig {
  /** Postgres connection string. Ignored when `db` is supplied. */
  dsn?: string;
  /** Override the Drizzle handle (tests). Defaults to a hardened pool over `dsn`. */
  db?: NodePgDatabase;
  now?: () => number;
}

type Row = {
  id: string;
  owner: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  createdAt: unknown;
  updatedAt: unknown;
};

const toSkill = (r: Row): UserSkill => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  description: r.description,
  body: r.body,
  enabled: r.enabled,
  // bigint comes back as a string from node-postgres.
  createdAt: Number(r.createdAt),
  updatedAt: Number(r.updatedAt),
});

const COLUMNS = {
  id: userSkills.id,
  owner: userSkills.owner,
  name: userSkills.name,
  description: userSkills.description,
  body: userSkills.body,
  enabled: userSkills.enabled,
  createdAt: userSkills.createdAt,
  updatedAt: userSkills.updatedAt,
};

export function createPgUserSkillStore(config: PgUserSkillStoreConfig): UserSkillStore {
  const ownPool = config.db
    ? undefined
    : createPgPool("userSkillStore", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);
  const now = config.now ?? (() => Date.now());

  const selectOwned = (owner: string) =>
    db.select(COLUMNS).from(userSkills).where(eq(userSkills.owner, owner)).orderBy(asc(userSkills.name));

  /** Validate and budget-check a would-be row against the owner's other skills. */
  const guard = async (owner: string, next: { name: string; description: string; body: string }, exceptId?: string) => {
    const invalid = validateSkillInput(next);
    if (invalid) throw new UserSkillError(invalid);
    const existing = (await selectOwned(owner)).map(toSkill);
    const others = existing.filter((s) => s.id !== exceptId);
    if (others.some((s) => s.name === next.name)) {
      throw new UserSkillError(`you already have a skill named "${next.name}"`);
    }
    const over = checkPersonalBudget(others, next.body);
    if (over) throw new UserSkillError(over);
  };

  return {
    async list(owner) {
      // Propagated, not swallowed: an empty settings page over intact rows reads as data loss.
      return (await selectOwned(owner)).map(toSkill);
    },

    async listEnabled(owner) {
      try {
        const rows = await db
          .select(COLUMNS)
          .from(userSkills)
          .where(and(eq(userSkills.owner, owner), eq(userSkills.enabled, true)))
          .orderBy(asc(userSkills.name));
        return rows.map(toSkill);
      } catch (e) {
        // The conversation starts with the deployment's skills rather than not at all.
        log.error("listEnabled failed; starting without this user's personal skills", {
          owner,
          error: formatError(e),
        });
        return [];
      }
    },

    async create(owner, input) {
      const next = { name: input.name, description: input.description, body: input.body };
      await guard(owner, next);
      const ts = now();
      const row: UserSkill = {
        id: randomUUID(),
        owner,
        ...next,
        enabled: input.enabled ?? true,
        createdAt: ts,
        updatedAt: ts,
      };
      await db.insert(userSkills).values(row);
      return row;
    },

    async patch(owner, id, patch) {
      const existing = (await selectOwned(owner)).map(toSkill).find((s) => s.id === id);
      if (!existing) return null;
      const next = {
        name: patch.name ?? existing.name,
        description: patch.description ?? existing.description,
        body: patch.body ?? existing.body,
      };
      await guard(owner, next, id);
      const updated: UserSkill = {
        ...existing,
        ...next,
        enabled: patch.enabled ?? existing.enabled,
        updatedAt: now(),
      };
      await db
        .update(userSkills)
        .set({
          name: updated.name,
          description: updated.description,
          body: updated.body,
          enabled: updated.enabled,
          updatedAt: updated.updatedAt,
        })
        // Owner-scoped: an id alone would let one user patch another's skill.
        .where(and(eq(userSkills.owner, owner), eq(userSkills.id, id)));
      return updated;
    },

    async remove(owner, id) {
      const res = await db
        .delete(userSkills)
        .where(and(eq(userSkills.owner, owner), eq(userSkills.id, id)));
      return (res.rowCount ?? 0) > 0;
    },

    async close() {
      await ownPool?.end().catch(() => {});
    },
  };
}
