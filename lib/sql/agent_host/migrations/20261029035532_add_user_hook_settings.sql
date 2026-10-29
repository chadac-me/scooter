-- Create "user_hook_settings" table
CREATE TABLE "user_hook_settings" (
  "owner" text NOT NULL,
  "hook_id" text NOT NULL,
  "enabled" boolean NOT NULL,
  "updated_at" bigint NOT NULL,
  PRIMARY KEY ("owner", "hook_id")
);
