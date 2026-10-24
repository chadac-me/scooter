-- scheduler database — declarative end-state schema (SOURCE OF TRUTH).
--
-- Atlas owns this file; `atlas migrate diff` writes migrations/ from it and the
-- ORM bindings are GENERATED from it via `just db-generate`. Edit tables HERE,
-- never in the service's inline DDL. Consumer: scheduler. Types mirror production
-- (SQLAlchemy `String` -> `character varying`).
-- See todo/draft/DECLARATIVE_SCHEMA_ATLAS.md.

-- A user task (kind 'user': a prompt on a cron, owned by whoever created it) or a
-- system task (kind 'system', id "system:<id>": a command synced from the deployment's
-- scooter.systemTasks, owned by config and never visible on the /tasks routes).
CREATE TABLE "scheduled_tasks" (
  "id"               character varying NOT NULL,
  "title"            text NOT NULL,
  "prompt"           text NOT NULL,
  -- NULL only for a system task that runs on `interval_seconds`.
  "cron"             character varying NULL,
  "timezone"         character varying NOT NULL,
  "owner"            character varying NOT NULL,
  "enabled"          boolean NOT NULL,
  "next_run_at"      timestamptz NULL,
  "last_run_at"      timestamptz NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  "kind"             character varying NOT NULL DEFAULT 'user',  -- 'user' | 'system'
  -- System tasks only: the executable and its arguments (a JSON array).
  "command"          text NULL,
  "args"             text NULL,
  "interval_seconds" integer NULL,
  "timeout_seconds"  integer NULL,
  "model"            character varying NULL,
  -- Why a system task cannot run in this image (its command is missing), else NULL.
  "unavailable"      text NULL,
  PRIMARY KEY ("id")
);

-- One firing. A user task's run is spawning|spawned|failed; a system task's is
-- running|succeeded|failed|timed_out.
CREATE TABLE "task_runs" (
  "id"                  character varying NOT NULL,
  "task_id"             character varying NOT NULL,
  "conversation_id"     character varying NULL,
  "status"              character varying NOT NULL,
  "error"               text NULL,
  "fired_at"            timestamptz NOT NULL DEFAULT now(),
  "finished_at"         timestamptz NULL,
  "exit_code"           integer NULL,
  -- sha256 of the secret a running system task records its spawns with; cleared at the end.
  "report_token_sha256" character varying NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "task_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "scheduled_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);

-- The conversations a system-task run opened, and for whom, so a run that spawned 200
-- is auditable and each user can see the runs that touched them.
CREATE TABLE "task_run_conversations" (
  "run_id"          character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "owner"           character varying NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("run_id", "conversation_id"),
  CONSTRAINT "task_run_conversations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "task_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX "task_run_conversations_by_owner" ON "task_run_conversations" ("owner");
