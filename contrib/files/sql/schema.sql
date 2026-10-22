-- contrib_files database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.files.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this
-- file (`just db-migrate <name>`), and that history is this contrib's alone, never
-- the broker's. Core generates no bindings from it; the row model in
-- scooter_contrib_files/store.py mirrors it, and tests/test_schema_matches.py
-- holds the two together.

-- Comments and answers a human anchors to a location in a sandbox file
-- (scooter_contrib_files/store.py). The viewer resolves the anchor against live
-- content and pushes an already-validated record here, so this table is a dumb,
-- correct store.
-- `id` is supplied by the caller, not minted here: the viewer retries a failed push
-- from an outbox, and a broker-minted id would turn every lost ack into a duplicate.
CREATE TABLE "annotations" (
  "id"              character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "path"            character varying NOT NULL,
  "anchor_line"     integer NOT NULL,
  "anchor_quote"    text NOT NULL,
  "kind"            character varying NOT NULL,
  "question_id"     character varying NULL,
  "thread"          character varying NOT NULL,
  "author"          character varying NOT NULL,
  "body"            text NOT NULL,
  "resolved"        boolean NOT NULL,
  "created_at"      character varying NOT NULL,
  "updated_at"      character varying NOT NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_annotations_conversation_id" ON "annotations" ("conversation_id");
CREATE INDEX "ix_annotations_thread" ON "annotations" ("thread");
CREATE INDEX "ix_annotations_path" ON "annotations" ("path");
