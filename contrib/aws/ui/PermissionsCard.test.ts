/**
 * The aws.permissions card's data handling: the shape check that sends anything else
 * to the plain card, and IAM's string-or-list statement fields.
 */

import { describe, expect, it } from "vitest";

import { allowedActionCount, grantOf, obligationsOf, statementsOf } from "./PermissionsCard.js";

const DATA = {
  account: "dev",
  risk: "medium",
  justification: "rotate the key",
  summary: "kms on one key",
  policy_document: {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["kms:Describe*", "kms:ScheduleKeyDeletion"], Resource: "arn:aws:kms:k" },
      { Effect: "Deny", Action: "kms:Decrypt", Resource: ["*"] },
    ],
  },
  managed_policy_arns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
  write_actions: ["kms:ScheduleKeyDeletion"],
  parent_request_id: null,
  obligations: [
    { id: "0", rules: ["secrets-guard/secret-values"], parts: ["secretsmanager:GetSecretValue on *"], approved_by: "sec@x" },
    { id: "1", rules: ["account default"], parts: [], approved_by: null },
  ],
};

describe("grantOf", () => {
  it("reads the broker's approval_data", () => {
    expect(grantOf(DATA)).toMatchObject({
      account: "dev",
      risk: "medium",
      managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
      writeActions: ["kms:ScheduleKeyDeletion"],
      parentRequestId: null,
    });
  });

  it("rejects data without an account or risk", () => {
    expect(grantOf(null)).toBeNull();
    expect(grantOf({ questions: [] })).toBeNull();
    expect(grantOf({ account: "dev" })).toBeNull();
  });

  it("treats a missing policy as none", () => {
    expect(grantOf({ account: "dev", risk: "low" })?.policyDocument).toBeNull();
  });
});

describe("statementsOf", () => {
  it("lists string-or-list fields", () => {
    const s = statementsOf(DATA.policy_document);
    expect(s).toEqual([
      {
        effect: "Allow",
        actions: ["kms:Describe*", "kms:ScheduleKeyDeletion"],
        resources: ["arn:aws:kms:k"],
        condition: undefined,
      },
      { effect: "Deny", actions: ["kms:Decrypt"], resources: ["*"], condition: undefined },
    ]);
    expect(allowedActionCount(s)).toBe(2);
  });

  it("accepts a lone statement object", () => {
    expect(statementsOf({ Statement: { Action: "s3:GetObject", Resource: "*" } })).toHaveLength(1);
  });

  it("returns none for no policy", () => {
    expect(statementsOf(null)).toEqual([]);
  });
});

describe("obligationsOf", () => {
  it("reads each approval and who gave it", () => {
    expect(grantOf(DATA)?.obligations).toEqual([
      { rules: ["secrets-guard/secret-values"], parts: ["secretsmanager:GetSecretValue on *"], approvedBy: "sec@x" },
      { rules: ["account default"], parts: [], approvedBy: null },
    ]);
  });

  it("returns none for a missing or malformed list", () => {
    expect(obligationsOf(undefined)).toEqual([]);
    expect(obligationsOf([null, 3])).toEqual([]);
  });
});
