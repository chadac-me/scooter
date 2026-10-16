-- Modify "conversations" table
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_model_set_by_check" CHECK (model_set_by = ANY (ARRAY['user'::text, 'agent'::text])), ADD COLUMN "model_set_by" text NULL;
