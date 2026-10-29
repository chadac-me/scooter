-- contrib_shares database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.shares.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this
-- file (`just db-migrate shares`). Core generates no bindings from it; the row
-- models in scooter_contrib_shares/store.py mirror it, and
-- tests/test_schema_matches.py holds the two together.

-- Published static shares — metadata head row.
CREATE TABLE "static_shares" (
  "uuid"            character varying NOT NULL,
  "owner"           character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "description"     text NOT NULL,
  "visibility"      character varying NOT NULL,
  "latest_version"  integer NOT NULL,
  "created_at"      character varying NOT NULL,
  "updated_at"      character varying NOT NULL,
  PRIMARY KEY ("uuid")
);
CREATE INDEX "ix_static_shares_owner" ON "static_shares" ("owner");
CREATE INDEX "ix_static_shares_conversation_id" ON "static_shares" ("conversation_id");
CREATE INDEX "ix_static_shares_visibility" ON "static_shares" ("visibility");

-- One immutable snapshot of a share's files per version.
-- Keyed on (share_uuid, version) with no serial id: rows copied from `broker` keep
-- their key, so there is no sequence that must be advanced past them.
CREATE TABLE "static_share_versions" (
  "share_uuid"  character varying NOT NULL,
  "version"     integer NOT NULL,
  "entry_point" character varying NOT NULL,
  "files_json"  text NOT NULL,
  "created_at"  character varying NOT NULL,
  PRIMARY KEY ("share_uuid", "version")
);
