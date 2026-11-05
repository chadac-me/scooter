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
