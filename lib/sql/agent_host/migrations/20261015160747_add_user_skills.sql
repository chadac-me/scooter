-- Create "user_skills" table
CREATE TABLE "user_skills" (
  "id" text NOT NULL,
  "owner" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "body" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "user_skills_by_owner" to table: "user_skills"
CREATE INDEX "user_skills_by_owner" ON "user_skills" ("owner");
-- Create index "user_skills_owner_name" to table: "user_skills"
CREATE UNIQUE INDEX "user_skills_owner_name" ON "user_skills" ("owner", "name");
