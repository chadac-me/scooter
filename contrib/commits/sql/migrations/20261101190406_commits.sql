-- Create "commit_identities" table
CREATE TABLE "commit_identities" (
  "user_id" character varying NOT NULL,
  "name" character varying NOT NULL,
  "email" character varying NOT NULL,
  "set_by" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("user_id")
);
-- Create "commit_identity_proposals" table
CREATE TABLE "commit_identity_proposals" (
  "id" character varying NOT NULL,
  "user_id" character varying NOT NULL,
  "conversation_id" character varying NOT NULL,
  "name" character varying NOT NULL,
  "email" character varying NOT NULL,
  "status" character varying NOT NULL,
  "created_at" character varying NOT NULL,
  "decided_at" character varying NULL,
  PRIMARY KEY ("id")
);
