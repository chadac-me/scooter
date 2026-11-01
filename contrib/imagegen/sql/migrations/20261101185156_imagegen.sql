-- Create "generations" table
CREATE TABLE "generations" (
  "id" character varying NOT NULL,
  "user_id" character varying NOT NULL,
  "backend" character varying NOT NULL,
  "model" character varying NOT NULL,
  "created_at" character varying NOT NULL,
  PRIMARY KEY ("id")
);
-- Create index "generations_user_id_created_at_idx" to table: "generations"
CREATE INDEX "generations_user_id_created_at_idx" ON "generations" ("user_id", "created_at");
