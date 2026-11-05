-- contrib_handoff database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.handoff.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this file
-- (`just db-migrate handoff`). The row models in scooter_contrib_handoff/store.py
-- mirror it, and tests/test_db.py holds them together.

-- An uploaded archive; its bytes live in handoff_bundle_chunks.
CREATE TABLE "handoff_bundles" (
  "id"          character varying NOT NULL,
  "uploader"    character varying NOT NULL,
  "state"       character varying NOT NULL,
  "size_bytes"  bigint NOT NULL,
  "sha256"      character varying NULL,
  "description" text NULL,
  "created_at"  character varying NOT NULL,
  "expires_at"  character varying NOT NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_handoff_bundles_uploader" ON "handoff_bundles" ("uploader");
CREATE INDEX "ix_handoff_bundles_expires_at" ON "handoff_bundles" ("expires_at");

-- A bundle's bytes, in upload order.
CREATE TABLE "handoff_bundle_chunks" (
  "bundle_id" character varying NOT NULL,
  "seq"       integer NOT NULL,
  "data"      bytea NOT NULL,
  PRIMARY KEY ("bundle_id", "seq")
);

-- A shared conversation the search index has folded in.
CREATE TABLE "handoff_conversations" (
  "conversation_id"  character varying NOT NULL,
  "title"            text NOT NULL,
  "owner"            character varying NULL,
  "last_activity_at" bigint NOT NULL,
  PRIMARY KEY ("conversation_id")
);

-- One indexed user or assistant message of a shared conversation.
CREATE TABLE "handoff_messages" (
  "conversation_id" character varying NOT NULL,
  "seq"             integer NOT NULL,
  "role"            character varying NOT NULL,
  "text"            text NOT NULL,
  PRIMARY KEY ("conversation_id", "seq")
);
CREATE INDEX "ix_handoff_messages_fts" ON "handoff_messages" USING gin (to_tsvector('english', "text"));
