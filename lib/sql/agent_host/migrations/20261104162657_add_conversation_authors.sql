-- Create "conversation_authors" table
CREATE TABLE "conversation_authors" (
  "conversation_id" text NOT NULL,
  "kind" text NOT NULL,
  "author" text NOT NULL,
  "first_at" bigint NOT NULL,
  PRIMARY KEY ("conversation_id", "kind", "author"),
  CONSTRAINT "conversation_authors_kind_check" CHECK (kind = ANY (ARRAY['identity'::text, 'user'::text, 'unknown'::text]))
);
