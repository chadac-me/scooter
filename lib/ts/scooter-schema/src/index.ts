/**
 * @scooter/schema: the generated Drizzle schema for Scooter's shared databases, one
 * namespace per database (a table name is only unique within one). Import only the
 * databases you write (see lib/sql/owners.toml):
 *
 *   import { webhooks, assertDatabase } from "@scooter/schema";
 *   await assertDatabase(pool, "webhooks");
 *   await db.select().from(webhooks.userIdentity);
 *
 * The per-database modules are generated from lib/sql/<db>/schema.sql by
 * `just db-generate`; guard.ts and this file are not.
 */

export * as webhooks from "./webhooks.js";
export * as scheduler from "./scheduler.js";
export * as broker from "./broker.js";
export * as byoc from "./byoc.js";
export * as agent_host from "./agent_host.js";
export { assertDatabase, DATABASES, type Database, type Queryable } from "./guard.js";
