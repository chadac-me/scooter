-- contrib_imagegen database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.imagegen.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this
-- file (`just db-migrate imagegen`). The row model in
-- scooter_contrib_imagegen/store.py mirrors it, and tests/test_db.py holds them
-- together.

-- One row per successful generation, counted against the per-user daily caps
-- (the contrib-wide one and each backend's own) in usage.py.
CREATE TABLE "generations" (
  "id"         character varying NOT NULL,
  "user_id"    character varying NOT NULL,
  "backend"    character varying NOT NULL,
  "model"      character varying NOT NULL,
  "created_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);

-- Today's count per user (and per user+backend) is the hot query.
CREATE INDEX "generations_user_id_created_at_idx" ON "generations" ("user_id", "created_at");
