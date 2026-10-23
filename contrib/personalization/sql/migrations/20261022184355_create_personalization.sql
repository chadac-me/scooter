-- Create "personalization_notes" table
CREATE TABLE "personalization_notes" (
  "id" character varying NOT NULL,
  "owner" character varying NOT NULL,
  "category" character varying NOT NULL,
  "note" text NOT NULL,
  "source" character varying NOT NULL,
  "pinned" boolean NOT NULL,
  "created_at" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_personalization_notes_category" to table: "personalization_notes"
CREATE INDEX "ix_personalization_notes_category" ON "personalization_notes" ("category");
-- Create index "ix_personalization_notes_owner" to table: "personalization_notes"
CREATE INDEX "ix_personalization_notes_owner" ON "personalization_notes" ("owner");
-- Create "personalization_profiles" table
CREATE TABLE "personalization_profiles" (
  "owner" character varying NOT NULL,
  "enabled" boolean NOT NULL,
  "last_analyzed_at" character varying NULL,
  "last_conversation_seen" character varying NULL,
  "refresh_requested_at" character varying NULL,
  "last_run_conversation" character varying NULL,
  PRIMARY KEY ("owner")
);
