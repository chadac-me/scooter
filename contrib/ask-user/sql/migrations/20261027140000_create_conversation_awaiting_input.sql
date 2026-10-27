-- Create "conversation_awaiting_input" table
CREATE TABLE "conversation_awaiting_input" (
  "conversation_id" text NOT NULL,
  "since" bigint NOT NULL,
  PRIMARY KEY ("conversation_id")
);
