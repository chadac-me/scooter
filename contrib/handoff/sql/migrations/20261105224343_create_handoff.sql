-- Create "handoff_bundle_chunks" table
CREATE TABLE "handoff_bundle_chunks" (
  "bundle_id" character varying NOT NULL,
  "seq" integer NOT NULL,
  "data" bytea NOT NULL,
  PRIMARY KEY ("bundle_id", "seq")
);
-- Create "handoff_bundles" table
CREATE TABLE "handoff_bundles" (
  "id" character varying NOT NULL,
  "uploader" character varying NOT NULL,
  "state" character varying NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" character varying NULL,
  "description" text NULL,
  "created_at" character varying NOT NULL,
  "expires_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_handoff_bundles_expires_at" to table: "handoff_bundles"
CREATE INDEX "ix_handoff_bundles_expires_at" ON "handoff_bundles" ("expires_at");
-- Create index "ix_handoff_bundles_uploader" to table: "handoff_bundles"
CREATE INDEX "ix_handoff_bundles_uploader" ON "handoff_bundles" ("uploader");
-- Create "handoff_conversations" table
CREATE TABLE "handoff_conversations" (
  "conversation_id" character varying NOT NULL,
  "title" text NOT NULL,
  "owner" character varying NULL,
  "last_activity_at" bigint NOT NULL,
  PRIMARY KEY ("conversation_id")
);
-- Create "handoff_messages" table
CREATE TABLE "handoff_messages" (
  "conversation_id" character varying NOT NULL,
  "seq" integer NOT NULL,
  "role" character varying NOT NULL,
  "text" text NOT NULL,
  PRIMARY KEY ("conversation_id", "seq")
);
-- Create index "ix_handoff_messages_fts" to table: "handoff_messages"
CREATE INDEX "ix_handoff_messages_fts" ON "handoff_messages" USING gin ((to_tsvector('english'::regconfig, text)));
