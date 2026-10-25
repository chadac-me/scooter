-- Modify "conversations" table
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_private_has_owner" CHECK ((visibility = 'shared'::text) OR (owner IS NOT NULL)), ADD CONSTRAINT "conversations_visibility_check" CHECK (visibility = ANY (ARRAY['shared'::text, 'private'::text])), ADD COLUMN "visibility" text NOT NULL DEFAULT 'shared';
