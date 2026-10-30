-- Modify "permission_requests" table
ALTER TABLE "permission_requests" ADD COLUMN "approval_obligations" text NULL;
-- Create "aws_request_approvals" table
CREATE TABLE "aws_request_approvals" (
  "request_id" character varying NOT NULL,
  "approver" character varying NOT NULL,
  "approved_at" character varying NOT NULL,
  "obligation_ids" text NOT NULL,
  PRIMARY KEY ("request_id", "approver")
);
