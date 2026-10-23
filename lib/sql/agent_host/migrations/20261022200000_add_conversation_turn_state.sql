-- Modify "conversations" table
ALTER TABLE "conversations" ADD COLUMN "run_started_at" bigint NULL, ADD COLUMN "last_reply_at" bigint NULL;
