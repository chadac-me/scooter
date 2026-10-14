/**
 * Runtime ownership guard, hand-written and stable across `just db-generate`. Each service
 * connects to exactly one shared database, and this asserts a client is pointed at it so a
 * mis-wired DSN fails fast at startup.
 */

/** The database names this package models, the atlas envs under lib/sql. */
export const DATABASES = ["webhooks", "scheduler", "broker", "byoc", "agent_host"] as const;
export type Database = (typeof DATABASES)[number];

/** Minimal shape of a node-postgres Pool/Client, enough to run one query. */
export interface Queryable {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Assert `db` is connected to the `expected` database, throwing otherwise. */
export async function assertDatabase(db: Queryable, expected: Database): Promise<void> {
  const res = await db.query("select current_database() as db");
  const actual = res.rows[0]?.db;
  if (actual !== expected) {
    throw new Error(
      `@scooter/schema: connected to database "${String(actual)}" but this client is for "${expected}" — refusing to run. A service must only use the database it owns (check its DSN's DB name).`,
    );
  }
}
