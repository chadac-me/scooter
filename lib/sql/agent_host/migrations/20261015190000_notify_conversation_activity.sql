-- Push activity and phase changes on conversations_changed, so the sidebar's ordering and
-- status dot no longer need the UI's GET /conversations poll. Why these are safe to push, and
-- why 20260902183131 called them a firehose: PR #776.
--
-- `kind` must stay in sync with the router's change.activityOnly: it is what keeps a title
-- edit from being delayed behind an activity window. Triggers cannot live in schema.sql
-- (Atlas Community does not diff FUNCTION/TRIGGER objects), so these migrations are the
-- source of truth and production replays them.
--
-- This replaces the function from 20261015024000 and the UPDATE trigger from 20260902183131;
-- the trigger is dropped and recreated because a WHEN clause cannot be altered in place.
CREATE OR REPLACE FUNCTION "conversations_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  change_kind text := 'meta';
BEGIN
  -- Every sidebar column except last_activity_at unchanged; an INSERT or DELETE is never 'activity'.
  IF TG_OP = 'UPDATE'
     AND OLD."title"       IS NOT DISTINCT FROM NEW."title"
     AND OLD."starred"     IS NOT DISTINCT FROM NEW."starred"
     AND OLD."user_titled" IS NOT DISTINCT FROM NEW."user_titled"
     AND OLD."owner"       IS NOT DISTINCT FROM NEW."owner"
     AND OLD."phase"       IS NOT DISTINCT FROM NEW."phase"
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
    OLD."last_activity_at" IS DISTINCT FROM NEW."last_activity_at"
  ) EXECUTE FUNCTION "conversations_notify"();
