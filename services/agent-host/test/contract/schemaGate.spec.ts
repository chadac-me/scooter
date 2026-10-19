/**
 * The schema/code gate: a database whose migrations are behind this build must fail
 * startup at once with a pointer at the migration Job, not be retried like a cold DB.
 */

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

import {
  EXPECTED_AGENT_HOST_SCHEMA_VERSION,
  SchemaMismatchError,
  checkSchemaVersion,
  isSchemaMismatch,
} from "../../src/db/schemaGate.js";
import { hydrateWithRetry } from "../../src/index.js";

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

const recorder = () => {
  const warns: Record<string, unknown>[] = [];
  const errors: { msg: string; fields: Record<string, unknown> }[] = [];
  return {
    warns,
    errors,
    log: {
      warn: (_m: string, f?: Record<string, unknown>) => void warns.push(f ?? {}),
      errorWith: (msg: string, _e: unknown, f?: Record<string, unknown>) =>
        void errors.push({ msg, fields: f ?? {} }),
    } as never,
  };
};

const virtualClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

describe("EXPECTED_AGENT_HOST_SCHEMA_VERSION", () => {
  it("is the newest lib/sql/agent_host migration", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = join(here, "../../../../lib/sql/agent_host/migrations");
    const versions = readdirSync(dir)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .map((f) => f.split("_")[0])
      .sort();
    expect(EXPECTED_AGENT_HOST_SCHEMA_VERSION).toBe(versions[versions.length - 1]);
  });
});

describe("hydrateWithRetry on a schema older than the code", () => {
  it("fails on the FIRST undefined-column error instead of retrying for the whole budget", async () => {
    const { log, errors, warns } = recorder();
    const clock = virtualClock();
    const hydrate = vi
      .fn()
      .mockRejectedValue(pgError("42703", 'column "model_set_by" does not exist'));

    const err = await hydrateWithRetry(hydrate, log, { now: clock.now, sleep: clock.sleep }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SchemaMismatchError);
    expect((err as Error).message).toMatch(/agent-db-migrate/);
    expect((err as Error).message).toMatch(/model_set_by/);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(warns).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toMatch(/schema is behind/);
  });

  it("treats an undefined table the same way", async () => {
    const hydrate = vi.fn().mockRejectedValue(pgError("42P01", 'relation "conversations" does not exist'));
    await expect(hydrateWithRetry(hydrate, recorder().log, virtualClock())).rejects.toBeInstanceOf(
      SchemaMismatchError,
    );
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it("still retries connection errors (a cold DB is not a schema mismatch)", async () => {
    const clock = virtualClock();
    const hydrate = vi
      .fn()
      .mockRejectedValueOnce(pgError("ECONNREFUSED", "connect ECONNREFUSED"))
      .mockResolvedValue(undefined);
    await hydrateWithRetry(hydrate, recorder().log, clock);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(isSchemaMismatch(pgError("57P03", "the database system is starting up"))).toBe(false);
  });
});

describe("checkSchemaVersion", () => {
  const db = (result: () => Promise<{ rows: Record<string, unknown>[] }>) => ({ query: vi.fn(result) });

  it("passes when the database is at the expected version", async () => {
    const r = await checkSchemaVersion(db(async () => ({ rows: [{ version: "20261016152707" }] })), "20261016152707");
    expect(r).toEqual({ status: "ok", dbVersion: "20261016152707" });
  });

  it("passes when the database is AHEAD (old pods mid-rollout after migrations ran)", async () => {
    const r = await checkSchemaVersion(db(async () => ({ rows: [{ version: "20270101000000" }] })), "20261016152707");
    expect(r.status).toBe("ok");
  });

  it("throws SchemaMismatchError naming both versions when the database is behind", async () => {
    const p = checkSchemaVersion(db(async () => ({ rows: [{ version: "20261015190000" }] })), "20261016152707");
    await expect(p).rejects.toBeInstanceOf(SchemaMismatchError);
    await expect(p).rejects.toThrow(/20261015190000.*20261016152707/);
  });

  it("throws when Atlas has no fully applied revision", async () => {
    await expect(
      checkSchemaVersion(db(async () => ({ rows: [{ version: null }] })), "20261016152707"),
    ).rejects.toBeInstanceOf(SchemaMismatchError);
  });

  it("reports an unmanaged database (no revision table) instead of failing", async () => {
    const r = await checkSchemaVersion(
      db(async () => {
        throw pgError("3F000", 'schema "atlas_schema_revisions" does not exist');
      }),
    );
    expect(r).toEqual({ status: "unmanaged" });
  });

  it("propagates connection errors unchanged so the caller retries them", async () => {
    const boom = pgError("ECONNREFUSED", "connect ECONNREFUSED");
    await expect(checkSchemaVersion(db(async () => { throw boom; }))).rejects.toBe(boom);
  });
});
