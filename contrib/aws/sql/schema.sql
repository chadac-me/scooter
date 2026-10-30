-- contrib_aws database — declarative end-state schema (SOURCE OF TRUTH).
--
-- This contrib's OWN database (`contribs.aws.db`), owned by the broker's role
-- because the store runs inside the broker. Atlas writes ./migrations from this
-- file (`just db-migrate <name>`), and that history is this contrib's alone, never
-- the broker's. Core generates no bindings from it; the row model in
-- scooter_contrib_aws/store.py mirrors it, and tests/test_schema_matches.py holds
-- the two together.

-- Scoped, time-limited AWS access requests (scooter_contrib_aws/store.py).
CREATE TABLE "permission_requests" (
  "request_id"            character varying NOT NULL,
  "conversation_id"       character varying NOT NULL,
  "target_account"        character varying NOT NULL,
  "justification"         text NOT NULL,
  "status"                character varying NOT NULL,
  "risk_level"            character varying NOT NULL,
  "policy_document"       text NULL,
  "managed_policy_arns"   text NOT NULL,
  "policy_summary"        text NOT NULL,
  "conversation_url"      text NULL,
  "parent_request_id"     character varying NULL,
  "requested_at"          character varying NOT NULL,
  "approved_at"           character varying NULL,
  "approved_by"           character varying NULL,
  "denied_at"             character varying NULL,
  "denied_by"             character varying NULL,
  "deny_reason"           text NULL,
  "revoked_at"            character varying NULL,
  "iam_role_arn"          character varying NULL,
  "iam_policy_arn"        character varying NULL,
  "role_expires_at"       character varying NULL,
  "credentials_issued_at" character varying NULL,
  "expires_at"            character varying NULL,
  -- JSON: the approvals the request needs, fixed when it is made (rules.Obligation).
  "approval_obligations"  text NULL,
  PRIMARY KEY ("request_id")
);
CREATE INDEX "ix_permission_requests_conversation_id" ON "permission_requests" ("conversation_id");
CREATE INDEX "ix_permission_requests_status" ON "permission_requests" ("status");
CREATE INDEX "ix_permission_requests_target_account" ON "permission_requests" ("target_account");

-- One row per approver per request; obligation_ids is the JSON list it satisfied.
CREATE TABLE "aws_request_approvals" (
  "request_id"     character varying NOT NULL,
  "approver"       character varying NOT NULL,
  "approved_at"    character varying NOT NULL,
  "obligation_ids" text NOT NULL,
  PRIMARY KEY ("request_id", "approver")
);
