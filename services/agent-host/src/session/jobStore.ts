/**
 * Durable background-job registry on the shared Postgres. A job's output lives in-pod
 * on the workspace PVC; this is only the index of {jobId, command, startedAt, notifiedAt}
 * that answers which jobs a conversation has across a restart or a move to another
 * replica. Reads consult Postgres first and fall back to a file registry on a miss,
 * backfilling what they find; a DB error on write is logged, never thrown into the
 * agent's turn. The table is declared in lib/sql/agent_host/schema.sql and this store
 * never creates it.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

import type { JobRecord, JobRegistry } from "./jobManager.js";
import type { SessionId } from "../types.js";

const { conversationJobs } = agent_host;

const log = logger("jobStore");

export interface PgJobStoreConfig {
  /** Postgres connection string. Ignored when `db` is supplied. */
  dsn?: string;
  /** Override the Drizzle handle (tests). Defaults to a hardened pool over `dsn`. */
  db?: NodePgDatabase;
  /**
   * Legacy file-backed registry to read through to on a Postgres miss, backfilled and served.
   */
  legacy?: Pick<JobRegistry, "listJobs">;
}

export interface PgJobStore extends JobRegistry {
  close(): Promise<void>;
}

/** Postgres-backed job registry over the generated @scooter/schema Drizzle client. */
export function createPgJobStore(config: PgJobStoreConfig): PgJobStore {
  // Kept so close() can end a pool we own; a caller-supplied db has its own lifecycle.
  const ownPool = config.db ? undefined : createPgPool("jobStore", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);

  const toJob = (row: { jobId: string; command: string; startedAt: unknown; notifiedAt: unknown }): JobRecord => ({
    jobId: row.jobId,
    command: row.command,
    // bigint comes back as a string from node-postgres.
    startedAt: Number(row.startedAt),
    ...(row.notifiedAt == null ? {} : { notifiedAt: Number(row.notifiedAt) }),
  });

  const values = (id: string, job: JobRecord) => ({
    conversationId: id,
    jobId: job.jobId,
    command: job.command,
    startedAt: job.startedAt,
    notifiedAt: job.notifiedAt ?? null,
  });

  const upsert = async (id: string, job: JobRecord): Promise<void> => {
    await db
      .insert(conversationJobs)
      .values(values(id, job))
      .onConflictDoUpdate({
        target: [conversationJobs.conversationId, conversationJobs.jobId],
        set: {
          command: job.command,
          startedAt: job.startedAt,
          notifiedAt: job.notifiedAt ?? null,
        },
      });
  };

  /**
   * Copy a legacy file registry into Postgres once, with DO NOTHING so a row already there
   * wins and a stale notifiedAt cannot re-announce a job.
   */
  const backfill = async (id: string, jobs: JobRecord[]): Promise<void> => {
    for (const job of jobs) {
      await db.insert(conversationJobs).values(values(id, job)).onConflictDoNothing();
    }
    log.info("backfilled a legacy file job registry into postgres", {
      conversation_id: id,
      jobs: jobs.length,
    });
  };

  return {
    async saveJob(id, job) {
      try {
        await upsert(id, job);
      } catch (e) {
        log.error("saveJob failed (job will not be listable)", {
          conversation_id: id,
          job_id: job.jobId,
          error: formatError(e),
        });
      }
    },

    async listJobs(id) {
      let rows: JobRecord[] = [];
      try {
        const found = await db
          .select({
            jobId: conversationJobs.jobId,
            command: conversationJobs.command,
            startedAt: conversationJobs.startedAt,
            notifiedAt: conversationJobs.notifiedAt,
          })
          .from(conversationJobs)
          .where(eq(conversationJobs.conversationId, id))
          .orderBy(desc(conversationJobs.startedAt));
        rows = found.map(toJob);
      } catch (e) {
        log.error("listJobs query failed", { conversation_id: id, error: formatError(e) });
      }
      if (rows.length > 0 || !config.legacy) return rows;

      // Postgres has nothing: read through to the legacy registry and backfill so the next read is
      // served from here.
      let legacy: JobRecord[] = [];
      try {
        legacy = await config.legacy.listJobs(id);
      } catch (e) {
        log.error("legacy job registry read failed", { conversation_id: id, error: formatError(e) });
        return rows;
      }
      if (legacy.length === 0) return rows;
      await backfill(id, legacy).catch((e) =>
        log.error("job backfill failed (serving the legacy rows anyway)", {
          conversation_id: id,
          error: formatError(e),
        }),
      );
      return legacy;
    },

    async updateJob(id, job) {
      try {
        // UPDATE, not upsert: a job absent from the registry must not be conjured into it.
        const res = await db
          .update(conversationJobs)
          .set({ command: job.command, startedAt: job.startedAt, notifiedAt: job.notifiedAt ?? null })
          .where(and(eq(conversationJobs.conversationId, id), eq(conversationJobs.jobId, job.jobId)));
        if ((res.rowCount ?? 0) === 0 && config.legacy) {
          // The job is still only in a legacy file registry, so pull the conversation forward and
          // apply the update.
          const legacy = await config.legacy.listJobs(id).catch(() => [] as JobRecord[]);
          if (legacy.some((j) => j.jobId === job.jobId)) {
            await backfill(id, legacy);
            await upsert(id, job);
          }
        }
      } catch (e) {
        log.error("updateJob failed (a completion may be announced twice)", {
          conversation_id: id,
          job_id: job.jobId,
          error: formatError(e),
        });
      }
    },

    async close() {
      await ownPool?.end().catch(() => {});
    },
  };
}
