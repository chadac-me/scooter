-- Create index "conversations_by_sandbox_ref" to table: "conversations"
CREATE INDEX "conversations_by_sandbox_ref" ON "conversations" ("sandbox_ref");

-- The router's cache LISTENs here; payload is the id.
-- Hand-written: Atlas Community does not diff triggers (see schema.sql).
CREATE FUNCTION "conversation_assignment_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('conversation_assignment', COALESCE(NEW.id, OLD.id));
  RETURN NULL;
END;
$$;

CREATE TRIGGER "conversation_assignment_upd" AFTER UPDATE ON "conversations"
  FOR EACH ROW WHEN (
    OLD."host_pod"        IS DISTINCT FROM NEW."host_pod" OR
    OLD."host_generation" IS DISTINCT FROM NEW."host_generation" OR
    OLD."phase"           IS DISTINCT FROM NEW."phase"
  ) EXECUTE FUNCTION "conversation_assignment_notify"();

CREATE TRIGGER "conversation_assignment_del" AFTER DELETE ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION "conversation_assignment_notify"();
