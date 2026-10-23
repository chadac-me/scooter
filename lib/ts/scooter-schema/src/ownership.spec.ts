import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import { DATABASES } from "./guard.js";

// lib/ts/scooter-schema/src/ -> repo lib/sql/, and the repo root.
const sqlDir = (p: string) => fileURLToPath(new URL(`../../../sql/${p}`, import.meta.url));
const repoPath = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

interface Manifest {
  [db: string]: {
    owner: string;
    tables: Record<string, { writers: string[]; readers: string[] }>;
  };
}

const load = (path: string) => parse(readFileSync(path, "utf8")) as unknown as Manifest;

/** lib/sql/owners.toml: the CORE databases only. */
const core = load(sqlDir("owners.toml"));

/** Each contrib database's own manifest, contrib/<name>/sql/owners.toml, keyed by contrib. */
const contribManifests: Record<string, Manifest> = Object.fromEntries(
  readdirSync(repoPath("contrib"))
    .filter((c) => existsSync(repoPath(`contrib/${c}/sql/owners.toml`)))
    .map((c) => [c, load(repoPath(`contrib/${c}/sql/owners.toml`))]),
);

/** Database -> its SQL dir: lib/sql/<db> for core, the declaring contrib's sql/ otherwise. */
const dirOf: Record<string, string> = {
  ...Object.fromEntries(Object.keys(core).map((db) => [db, `lib/sql/${db}`])),
  ...Object.fromEntries(
    Object.entries(contribManifests).flatMap(([c, m]) => Object.keys(m).map((db) => [db, `contrib/${c}/sql`])),
  ),
};
const manifest: Manifest = Object.assign({}, core, ...Object.values(contribManifests));

/** Table names a schema.sql declares (CREATE TABLE "<name>"). */
function tablesInSchema(db: string): string[] {
  const sql = readFileSync(repoPath(`${dirOf[db]}/schema.sql`), "utf8");
  return [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]).sort();
}

/** The CORE databases generated from the `scooter.db` module option. A contrib's own database is private to it, so core's guards never list it. */
const generatedDatabases = Object.keys(core);
const contribDatabases = Object.values(contribManifests).flatMap((m) => Object.keys(m));

describe("ownership manifests (lib/sql/owners.toml + contrib/*/sql/owners.toml)", () => {
  it("lists exactly the core databases that have a schema", () => {
    expect([...generatedDatabases].sort()).toEqual([...DATABASES].sort());
  });

  // Both guards' DATABASES are hand-written (guard.ts's `as const` gives `Database` its literal union), and the Python guard is checked here because its own nix build cannot read lib/sql.
  it("guard.ts DATABASES matches the generated spec", () => {
    expect([...DATABASES].sort()).toEqual([...generatedDatabases].sort());
  });

  it("guard.py DATABASES matches the generated spec", () => {
    const py = readFileSync(
      fileURLToPath(new URL("../../../py/scooter-schema/src/scooter_schema/guard.py", import.meta.url)),
      "utf8",
    );
    const tuple = py.match(/^DATABASES = \(([^)]*)\)/m);
    expect(tuple, "guard.py must declare a DATABASES tuple").not.toBeNull();
    const names = [...tuple![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(names.sort()).toEqual([...generatedDatabases].sort());
  });

  it("keeps every contrib database inside its contrib: one per contrib, none in lib/sql", () => {
    for (const [c, m] of Object.entries(contribManifests)) expect(Object.keys(m), `contrib/${c}/sql/owners.toml`).toHaveLength(1);
    for (const db of contribDatabases) expect(Object.keys(core)).not.toContain(db);
    expect(readFileSync(sqlDir("atlas.hcl"), "utf8")).not.toMatch(/env "contrib_|contrib\//);
  });

  for (const db of [...DATABASES, ...contribDatabases]) {
    it(`[${db}] lists exactly the tables schema.sql defines`, () => {
      const declared = tablesInSchema(db);
      const owned = Object.keys(manifest[db].tables).sort();
      // A table added to schema.sql without an owner, or removed, fails here.
      expect(owned).toEqual(declared);
    });

    it(`[${db}] every table names at least one writer`, () => {
      for (const [table, rule] of Object.entries(manifest[db].tables)) {
        // A table with two legitimate writers is modelled as a list rather than duplicated across databases.
        expect(Array.isArray(rule.writers), `${db}.${table} needs a writers list`).toBe(true);
        expect(rule.writers.length, `${db}.${table} needs at least one writer`).toBeGreaterThan(0);
        expect(Array.isArray(rule.readers), `${db}.${table} needs a readers list`).toBe(true);
      }
    });

    it(`[${db}] no service is both a writer and a reader of one table`, () => {
      // readers is the read-only set, since a writer already implies read access.
      for (const [table, rule] of Object.entries(manifest[db].tables)) {
        const both = rule.writers.filter((w) => rule.readers.includes(w));
        expect(both, `${db}.${table}: ${both.join(",")} is listed as writer AND reader`).toEqual([]);
      }
    });
  }
});

describe("remote_agents is ONE table, not two", () => {
  it("is declared in exactly one database", () => {
    const dbs = DATABASES.filter((db) => tablesInSchema(db).includes("remote_agents"));
    expect(dbs).toEqual(["byoc"]);
  });

  it("records BOTH writers, which is what removed the need for a second copy", () => {
    const writers = manifest.byoc.tables.remote_agents.writers;
    expect([...writers].sort()).toEqual(["agent-host", "byoc-controller"]);
  });
});
