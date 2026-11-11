-- Modify "resource_links" table
ALTER TABLE "resource_links" ADD COLUMN "state" character varying NULL;

-- The board's For you filter reads a link's state, so the sidebar must learn of a change to it
-- live, like a title. Triggers live in migrations only (see 20261015170000_notify_resource_links).
DROP TRIGGER IF EXISTS "resource_links_notify_upd" ON "resource_links";
CREATE TRIGGER "resource_links_notify_upd" AFTER UPDATE ON "resource_links"
  FOR EACH ROW WHEN (
    OLD."conversation_id" IS DISTINCT FROM NEW."conversation_id" OR
    OLD."source"          IS DISTINCT FROM NEW."source"          OR
    OLD."resource_type"   IS DISTINCT FROM NEW."resource_type"   OR
    OLD."url"             IS DISTINCT FROM NEW."url"             OR
    OLD."title"           IS DISTINCT FROM NEW."title"           OR
    OLD."state"           IS DISTINCT FROM NEW."state"
  ) EXECUTE FUNCTION "resource_links_notify"();
