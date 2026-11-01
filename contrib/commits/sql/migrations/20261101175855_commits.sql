-- Create "commit_identities" table
CREATE TABLE "commit_identities" (
  "user_id" character varying NOT NULL,
  "name" character varying NOT NULL,
  "email" character varying NOT NULL,
  "set_by" character varying NOT NULL,
  "updated_at" character varying NOT NULL,
  PRIMARY KEY ("user_id")
);
