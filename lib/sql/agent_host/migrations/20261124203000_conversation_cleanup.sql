-- Modify "conversations" table
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_cleanup_check" CHECK (cleanup = ANY (ARRAY['conversation'::text, 'sandbox'::text])), ADD COLUMN "cleanup" text NULL;
