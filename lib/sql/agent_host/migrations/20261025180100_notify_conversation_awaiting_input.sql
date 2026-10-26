-- Push conversation_awaiting_input changes as 'meta' on 'conversations_changed', so the sidebar's
-- "!" appears as soon as the agent asks the user. The payload names the conversation, as a
-- conversations-row change would, so the router re-reads the row with no second LISTEN.
--
-- The owner comes from the parent row. When that row is gone (the cascade from a conversation
-- delete), nothing is sent: the conversations DELETE trigger already announced the removal, and
-- an upsert naming a missing row would only make the router re-read it for nothing.
--
-- See 20261015190000 for why triggers live here and not in schema.sql.
CREATE FUNCTION "conversation_awaiting_input_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  conv_id text := COALESCE(NEW.conversation_id, OLD.conversation_id);
  conv_owner text;
BEGIN
  SELECT c.owner INTO conv_owner FROM "conversations" c WHERE c.id = conv_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('conversations_changed',
    json_build_object('id', conv_id, 'op', 'upsert', 'kind', 'meta', 'owner', conv_owner)::text);
  RETURN NULL; -- AFTER trigger: the return value is ignored.
END;
$$;

CREATE TRIGGER "conversation_awaiting_input_notify" AFTER INSERT OR DELETE ON "conversation_awaiting_input"
  FOR EACH ROW EXECUTE FUNCTION "conversation_awaiting_input_notify"();

CREATE TRIGGER "conversation_awaiting_input_notify_upd" AFTER UPDATE ON "conversation_awaiting_input"
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION "conversation_awaiting_input_notify"();
