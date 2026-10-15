-- NOTIFY on resource_links changes so the conversation-router can push a conversation's
-- links live instead of the UI polling GET /conversations for them. Why: PR #779.
--
-- resource_links lives in THIS database while the conversations row lives in agent_host, so
-- nothing the agent_host trigger fires can see a link being attached: the router listens on
-- both and re-reads the same row either way. Triggers cannot live in schema.sql (Atlas
-- Community does not diff FUNCTION/TRIGGER objects), so this migration is the source of
-- truth and production replays it.
--
-- The payload names the conversation, not the link: the router answers every notification by
-- re-reading that conversation's whole link set, so a link's own columns would be ignored.
CREATE OR REPLACE FUNCTION "resource_links_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  conv text := COALESCE(NEW."conversation_id", OLD."conversation_id");
BEGIN
  IF conv IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('resource_links_changed', json_build_object('conversationId', conv)::text);
  -- An UPDATE that moves a link between conversations leaves the old one stale otherwise.
  IF TG_OP = 'UPDATE' AND OLD."conversation_id" IS DISTINCT FROM NEW."conversation_id"
     AND OLD."conversation_id" IS NOT NULL THEN
    PERFORM pg_notify('resource_links_changed',
      json_build_object('conversationId', OLD."conversation_id")::text);
  END IF;
  RETURN NULL; -- AFTER trigger: the return value is ignored.
END;
$$;

CREATE TRIGGER "resource_links_notify_ins" AFTER INSERT ON "resource_links"
  FOR EACH ROW EXECUTE FUNCTION "resource_links_notify"();

CREATE TRIGGER "resource_links_notify_del" AFTER DELETE ON "resource_links"
  FOR EACH ROW EXECUTE FUNCTION "resource_links_notify"();

-- Only the columns the sidebar renders; `ref` is detail the list never shows.
CREATE TRIGGER "resource_links_notify_upd" AFTER UPDATE ON "resource_links"
  FOR EACH ROW WHEN (
    OLD."conversation_id" IS DISTINCT FROM NEW."conversation_id" OR
    OLD."source"          IS DISTINCT FROM NEW."source"          OR
    OLD."resource_type"   IS DISTINCT FROM NEW."resource_type"   OR
    OLD."url"             IS DISTINCT FROM NEW."url"             OR
    OLD."title"           IS DISTINCT FROM NEW."title"
  ) EXECUTE FUNCTION "resource_links_notify"();
