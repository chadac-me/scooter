-- contrib_personalization database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.personalization.db`), owned by the broker's
-- role because the store runs inside the broker. Atlas writes ./migrations from this
-- file (`just db-migrate <name>`), and that history is this contrib's alone, never
-- the broker's. Core generates no bindings from it; the row models in
-- scooter_contrib_personalization/store.py mirror it, and tests/test_schema_matches.py
-- holds them together.

-- Per-user personalization profile; no row means enabled and never analysed.
CREATE TABLE "personalization_profiles" (
  "owner"                  character varying NOT NULL,
  "enabled"                boolean NOT NULL,
  "last_analyzed_at"       character varying NULL,
  "last_conversation_seen" character varying NULL,
  "refresh_requested_at"   character varying NULL,
  "last_run_conversation"  character varying NULL,
  PRIMARY KEY ("owner")
);

-- A personalization profile's notes; `category` is an open set of slugs.
CREATE TABLE "personalization_notes" (
  "id"         character varying NOT NULL,
  "owner"      character varying NOT NULL,
  "category"   character varying NOT NULL,
  "note"       text NOT NULL,
  "source"     character varying NOT NULL,
  "pinned"     boolean NOT NULL,
  "created_at" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_personalization_notes_owner" ON "personalization_notes" ("owner");
CREATE INDEX "ix_personalization_notes_category" ON "personalization_notes" ("category");
