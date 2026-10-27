-- contrib_ask_user database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.ask-user.db`), owned by agent-host's role.
-- Atlas writes ./migrations from this file (`just db-migrate <name>`). It backs core's
-- `awaiting-input` feature, so agent-host and the router reach it as
-- AWAITING_INPUT_DB_NAME without naming this contrib.

-- Conversations whose agent is waiting on the user's answer to an interrupt (a question
-- or an approval), for the sidebar's "!". A row exists only while the wait does. No
-- foreign key: conversations live in agent_host, so agent-host deletes the row itself.
-- Its NOTIFY trigger lives in migrations/<ts>_notify_conversation_awaiting_input.sql,
-- since Atlas Community does not diff triggers.
CREATE TABLE "conversation_awaiting_input" (
  "conversation_id" text NOT NULL,
  -- When the wait began, epoch ms.
  "since"           bigint NOT NULL,
  PRIMARY KEY ("conversation_id")
);
