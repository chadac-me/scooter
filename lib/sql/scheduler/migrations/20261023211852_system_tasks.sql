-- Modify "scheduled_tasks" table
ALTER TABLE "scheduled_tasks" ALTER COLUMN "cron" DROP NOT NULL, ADD COLUMN "kind" character varying NOT NULL DEFAULT 'user', ADD COLUMN "command" text NULL, ADD COLUMN "args" text NULL, ADD COLUMN "interval_seconds" integer NULL, ADD COLUMN "timeout_seconds" integer NULL, ADD COLUMN "model" character varying NULL, ADD COLUMN "unavailable" text NULL;
-- Modify "task_runs" table
ALTER TABLE "task_runs" ADD COLUMN "finished_at" timestamptz NULL, ADD COLUMN "exit_code" integer NULL, ADD COLUMN "report_token_sha256" character varying NULL;
-- Create "task_run_conversations" table
CREATE TABLE "task_run_conversations" (
  "run_id" character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "owner" character varying NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("run_id", "conversation_id"),
  CONSTRAINT "task_run_conversations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "task_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "task_run_conversations_by_owner" to table: "task_run_conversations"
CREATE INDEX "task_run_conversations_by_owner" ON "task_run_conversations" ("owner");
