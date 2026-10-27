-- Push every conversation_awaiting_input change on 'conversation_awaiting_input_changed',
-- so the sidebar's "!" appears as soon as the agent asks. The payload only names the
-- conversation: the router re-reads its row, owner included, from agent_host.
--
-- Triggers live in migrations, not schema.sql: Atlas Community does not diff them.
CREATE FUNCTION "conversation_awaiting_input_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('conversation_awaiting_input_changed',
    json_build_object('conversationId', COALESCE(NEW.conversation_id, OLD.conversation_id))::text);
  RETURN NULL; -- AFTER trigger: the return value is ignored.
END;
$$;

CREATE TRIGGER "conversation_awaiting_input_notify" AFTER INSERT OR DELETE ON "conversation_awaiting_input"
  FOR EACH ROW EXECUTE FUNCTION "conversation_awaiting_input_notify"();

CREATE TRIGGER "conversation_awaiting_input_notify_upd" AFTER UPDATE ON "conversation_awaiting_input"
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION "conversation_awaiting_input_notify"();
