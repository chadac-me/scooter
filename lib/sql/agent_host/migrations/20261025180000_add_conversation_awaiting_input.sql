-- Create "conversation_awaiting_input" table
CREATE TABLE "conversation_awaiting_input" (
  "conversation_id" text NOT NULL,
  "since" bigint NOT NULL,
  PRIMARY KEY ("conversation_id"),
  CONSTRAINT "conversation_awaiting_input_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
