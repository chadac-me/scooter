/**
 * Contract tests for the personal-skills store. Two properties matter here and neither is
 * visible from the route tests: every statement is scoped to the owner in SQL (an id alone
 * would let one user patch or delete another's skill), and the two read paths fail
 * differently on purpose — the settings page would rather show an error than an empty page
 * over intact rows, while a conversation would rather start without personal skills than
 * not start.
 */

import { describe, it, expect } from "vitest";

import { drizzle } from "drizzle-orm/node-postgres";

import { createPgUserSkillStore, UserSkillError } from "../../src/session/userSkillStore.js";

type Call = { sql: string; params: unknown[] };

/**
 * A pg client standing under Drizzle that records the SQL it is handed. Reads answer from
 * `rows` (drizzle asks for rowMode:"array"), writes report one affected row.
 */
function recordingDb(rows: unknown[][] = []) {
  const calls: Call[] = [];
  const client = {
    async query(cfg: unknown, paramsIn: unknown[] = []) {
      const sql = typeof cfg === "string" ? cfg : ((cfg as { text: string }).text ?? "");
      const params = (typeof cfg === "object" && (cfg as { values?: unknown[] }).values) || paramsIn;
      calls.push({ sql, params: [...params] });
      if (/^\s*select/i.test(sql)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 1 };
    },
  };
  return { db: drizzle(client as never), calls };
}

/** A client that fails every statement, standing in for a database outage. */
function brokenDb() {
  return drizzle({
    async query() {
      throw new Error("connection refused");
    },
  } as never);
}

/** One stored row in the column order the store selects. */
const row = (over: Partial<Record<string, unknown>> = {}) => {
  const r = {
    id: "s1",
    owner: "alice",
    name: "acme",
    description: "when in acme/app",
    body: "notes",
    enabled: true,
    createdAt: "1000",
    updatedAt: "1000",
    ...over,
  };
  return [r.id, r.owner, r.name, r.description, r.body, r.enabled, r.createdAt, r.updatedAt];
};

/** Every statement in `calls` that reached the database. */
const sqlOf = (calls: Call[]) => calls.map((c) => c.sql.toLowerCase());

describe("personal-skill store scoping", () => {
  it("list selects by owner and hands back bigint timestamps as numbers", async () => {
    const { db, calls } = recordingDb([row()]);
    const store = createPgUserSkillStore({ db });
    const skills = await store.list("alice");
    expect(skills).toHaveLength(1);
    // node-postgres returns bigint as a string; a string createdAt would sort and render wrong.
    expect(skills[0].createdAt).toBe(1000);
    expect(calls[0].sql.toLowerCase()).toContain("where");
    expect(calls[0].params).toContain("alice");
  });

  it("listEnabled filters on enabled IN THE QUERY, not in the host", async () => {
    // The injection path must not pull a user's disabled skills over the wire at all.
    const { db, calls } = recordingDb([row()]);
    const store = createPgUserSkillStore({ db });
    await store.listEnabled("alice");
    expect(calls[0].sql.toLowerCase()).toContain("enabled");
    expect(calls[0].params).toEqual(expect.arrayContaining(["alice", true]));
  });

  it("patch scopes the UPDATE to the owner as well as the id", async () => {
    // An id-only WHERE would let any caller patch any skill by guessing a uuid.
    const { db, calls } = recordingDb([row()]);
    const store = createPgUserSkillStore({ db, now: () => 2000 });
    const updated = await store.patch("alice", "s1", { enabled: false });
    expect(updated?.enabled).toBe(false);
    const update = calls.find((c) => /^\s*update/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.params).toEqual(expect.arrayContaining(["alice", "s1"]));
    expect(updated?.updatedAt).toBe(2000);
  });

  it("patch answers null for an id the owner does not have, without issuing an UPDATE", async () => {
    const { db, calls } = recordingDb([]); // the owner has nothing
    const store = createPgUserSkillStore({ db });
    expect(await store.patch("alice", "s1", { enabled: false })).toBeNull();
    expect(sqlOf(calls).some((s) => s.startsWith("update"))).toBe(false);
  });

  it("remove scopes the DELETE to the owner as well as the id", async () => {
    const { db, calls } = recordingDb([]);
    const store = createPgUserSkillStore({ db });
    expect(await store.remove("alice", "s1")).toBe(true);
    const del = calls.find((c) => /^\s*delete/i.test(c.sql));
    expect(del!.params).toEqual(expect.arrayContaining(["alice", "s1"]));
  });

  it("create stamps the caller as owner rather than trusting the input", async () => {
    const { db, calls } = recordingDb([]);
    const store = createPgUserSkillStore({ db, now: () => 5 });
    const made = await store.create("alice", { name: "acme", description: "when in acme/app", body: "notes" });
    expect(made.owner).toBe("alice");
    expect(made.enabled).toBe(true);
    const insert = calls.find((c) => /^\s*insert/i.test(c.sql));
    expect(insert!.params).toContain("alice");
  });

  it("create refuses a name the owner already has, before touching the table", async () => {
    // The unique index would catch it, but as a 500 rather than the message the form shows.
    const { db, calls } = recordingDb([row({ name: "acme" })]);
    const store = createPgUserSkillStore({ db });
    await expect(store.create("alice", { name: "acme", description: "d", body: "b" })).rejects.toThrow(
      UserSkillError,
    );
    expect(sqlOf(calls).some((s) => s.startsWith("insert"))).toBe(false);
  });

  it("create refuses an invalid name with the reason, not a constraint violation", async () => {
    const { db } = recordingDb([]);
    const store = createPgUserSkillStore({ db });
    await expect(store.create("alice", { name: "../escape", description: "d", body: "b" })).rejects.toThrow(
      /name must be lowercase/,
    );
  });

  it("patch excludes the row being edited from the duplicate-name check", async () => {
    // Saving a skill without renaming it must not collide with itself.
    const { db } = recordingDb([row({ name: "acme" })]);
    const store = createPgUserSkillStore({ db });
    await expect(store.patch("alice", "s1", { body: "new notes" })).resolves.toMatchObject({ body: "new notes" });
  });

  it("listEnabled degrades to [] when the database is down, so the conversation still starts", async () => {
    const store = createPgUserSkillStore({ db: brokenDb() });
    await expect(store.listEnabled("alice")).resolves.toEqual([]);
  });

  it("list PROPAGATES a database error, so the settings page never claims you have no skills", async () => {
    const store = createPgUserSkillStore({ db: brokenDb() });
    await expect(store.list("alice")).rejects.toThrow();
  });
});
