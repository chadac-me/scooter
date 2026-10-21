-- Create "annotations" table
CREATE TABLE "annotations" (
  "id" character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "path" character varying NOT NULL,
  "anchor_line" integer NOT NULL,
  "anchor_quote" text NOT NULL,
  "kind" character varying NOT NULL,
  "question_id" character varying NULL,
  "thread" character varying NOT NULL,
  "author" character varying NOT NULL,
  "body" text NOT NULL,
  "resolved" boolean NOT NULL,
  "created_at" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "ix_annotations_conversation_id" to table: "annotations"
CREATE INDEX "ix_annotations_conversation_id" ON "annotations" ("conversation_id");
-- Create index "ix_annotations_path" to table: "annotations"
CREATE INDEX "ix_annotations_path" ON "annotations" ("path");
-- Create index "ix_annotations_thread" to table: "annotations"
CREATE INDEX "ix_annotations_thread" ON "annotations" ("thread");
