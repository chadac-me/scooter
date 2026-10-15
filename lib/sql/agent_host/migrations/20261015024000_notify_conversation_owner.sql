-- Add `owner` to the conversations_changed payload so the conversation-router can fan a
-- REMOVAL out under the same visibility rule as an upsert. On DELETE the row is gone before
-- the router can re-read it, so OLD.owner in the payload is the only copy of the owner a
-- removal could ever be filtered by.
--
-- This REPLACES the function body from 20260902183131_notify_conversation_changes.sql; that
-- migration remains the source of truth for the two triggers (which columns push), and this
-- one for the payload. Triggers still cannot live in schema.sql — Atlas Community does not
-- diff FUNCTION/TRIGGER objects — so keep both in sync with the router by hand.
CREATE OR REPLACE FUNCTION "conversations_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('conversations_changed',
    json_build_object('id', COALESCE(NEW.id, OLD.id),
                      'op', CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END,
                      -- NULL for an unowned conversation, which the router treats as it does an unowned upsert.
                      'owner', COALESCE(NEW.owner, OLD.owner))::text);
  RETURN NULL; -- AFTER trigger: the return value is ignored.
END;
$$;
