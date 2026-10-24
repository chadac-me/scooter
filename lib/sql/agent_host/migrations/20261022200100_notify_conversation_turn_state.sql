-- Push run_started_at / last_reply_at so the sidebar's active/unread dot is live. They are 'meta',
-- not 'activity': a turn ending must not wait behind the router's activity coalescing window.
--
-- Replaces the function and UPDATE trigger from 20261015190000; see that file for why triggers
-- live here and not in schema.sql.
CREATE OR REPLACE FUNCTION "conversations_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_kind text := 'meta';
BEGIN
  -- Every sidebar column except last_activity_at unchanged; an INSERT or DELETE is never 'activity'.
  IF TG_OP = 'UPDATE'
     AND OLD."title"          IS NOT DISTINCT FROM NEW."title"
     AND OLD."starred"        IS NOT DISTINCT FROM NEW."starred"
     AND OLD."user_titled"    IS NOT DISTINCT FROM NEW."user_titled"
     AND OLD."owner"          IS NOT DISTINCT FROM NEW."owner"
     AND OLD."phase"          IS NOT DISTINCT FROM NEW."phase"
     AND OLD."run_started_at" IS NOT DISTINCT FROM NEW."run_started_at"
     AND OLD."last_reply_at"  IS NOT DISTINCT FROM NEW."last_reply_at"
  THEN
    change_kind := 'activity';
  END IF;
  PERFORM pg_notify('conversations_changed',
    json_build_object('id', COALESCE(NEW.id, OLD.id),
                      'op', CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END,
                      'kind', change_kind,
                      -- NULL for an unowned conversation, which the router treats as it does an unowned upsert.
                      'owner', COALESCE(NEW.owner, OLD.owner))::text);
  RETURN NULL; -- AFTER trigger: the return value is ignored.
END;
$$;

DROP TRIGGER "conversations_notify_upd" ON "conversations";

CREATE TRIGGER "conversations_notify_upd" AFTER UPDATE ON "conversations"
  FOR EACH ROW WHEN (
    OLD."title"            IS DISTINCT FROM NEW."title"            OR
    OLD."starred"          IS DISTINCT FROM NEW."starred"          OR
    OLD."user_titled"      IS DISTINCT FROM NEW."user_titled"      OR
    OLD."owner"            IS DISTINCT FROM NEW."owner"            OR
    OLD."phase"            IS DISTINCT FROM NEW."phase"            OR
    OLD."run_started_at"   IS DISTINCT FROM NEW."run_started_at"   OR
    OLD."last_reply_at"    IS DISTINCT FROM NEW."last_reply_at"    OR
    OLD."last_activity_at" IS DISTINCT FROM NEW."last_activity_at"
  ) EXECUTE FUNCTION "conversations_notify"();
