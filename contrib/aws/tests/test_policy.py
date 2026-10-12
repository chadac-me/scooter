"""Guardrail tests for the three policy layers: structural validation, the global deny-list, and per-account bounds."""

from scooter_contrib_aws import policy
from scooter_contrib_aws.models import RiskLevel

V = "2012-10-17"


def stmt(action, resource="*", effect="Allow"):
    return {"Version": V, "Statement": [{"Effect": effect, "Action": action, "Resource": resource}]}


# --- Layer 1: structural -------------------------------------------------
def test_valid_read_policy_passes():
    assert policy.validate_policy(stmt("s3:GetObject", "arn:aws:s3:::b/*")) == []


def test_wrong_version_rejected():
    p = {"Version": "2008-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"}]}
    assert any("Version" in e for e in policy.validate_policy(p))


def test_deny_effect_rejected():
    assert any("Allow" in e for e in policy.validate_policy(stmt("s3:GetObject", effect="Deny")))


def test_full_action_wildcard_rejected():
    assert any("full wildcard" in e for e in policy.validate_policy(stmt("*")))


def test_missing_resource_rejected():
    p = {"Version": V, "Statement": [{"Effect": "Allow", "Action": "s3:GetObject"}]}
    assert any("Resource is required" in e for e in policy.validate_policy(p))


def test_too_many_statements_rejected():
    p = {"Version": V, "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"}] * 21}
    assert any("maximum" in e for e in policy.validate_policy(p))


# --- Layer 2: global deny list ------------------------------------------
def test_iam_privilege_escalation_blocked():
    for action in ("iam:CreateRole", "iam:PassRole", "iam:AttachRolePolicy", "iam:CreateAccessKey"):
        errs = policy.validate_policy(stmt(action))
        assert any("blocked" in e for e in errs), action


def test_blocked_pattern_matches_wildcard():
    assert any("blocked" in e for e in policy.validate_policy(stmt("guardduty:DeletePublishingDestination")))


def test_kms_delete_blocked_case_insensitive():
    assert any("blocked" in e for e in policy.validate_policy(stmt("KMS:ScheduleKeyDeletion")))


# --- prod-account extra strictness --------------------------------------
def test_prod_write_with_wildcard_resource_rejected():
    errs = policy.validate_policy(stmt("s3:PutObject", "*"), target_account="acme-production")
    assert any("production" in e for e in errs)


def test_prod_service_wide_write_wildcard_rejected():
    errs = policy.validate_policy(stmt("ec2:*", "*"), target_account="acme-prod")
    assert any("too broad" in e for e in errs)


def test_nonprod_wildcard_resource_on_write_allowed():
    assert policy.validate_policy(stmt("s3:PutObject", "*"), target_account="acme-dev") == []


# --- risk classification -------------------------------------------------
def test_risk_levels():
    assert policy.classify_risk(stmt("s3:GetObject"), "dev") == RiskLevel.LOW
    assert policy.classify_risk(stmt("s3:PutObject"), "dev") == RiskLevel.MEDIUM
    assert policy.classify_risk(stmt("s3:GetObject"), "prod") == RiskLevel.MEDIUM
    assert policy.classify_risk(stmt("s3:PutObject"), "production") == RiskLevel.HIGH


# --- Layer 3: per-account bounds ----------------------------------------
def test_action_within_bounds_passes():
    allowed = {"Statement": [{"Action": ["s3:Get*", "s3:List*"], "Resource": ["*"]}]}
    assert policy.validate_policy_within_bounds(stmt("s3:GetObject"), allowed) == []


def test_action_outside_bounds_rejected():
    allowed = {"Statement": [{"Action": ["s3:Get*"], "Resource": ["*"]}]}
    errs = policy.validate_policy_within_bounds(stmt("s3:DeleteObject"), allowed)
    assert any("not within the allowed" in e for e in errs)


def test_resource_outside_bounds_rejected():
    allowed = {"Statement": [{"Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::allowed/*"]}]}
    errs = policy.validate_policy_within_bounds(
        stmt("s3:GetObject", "arn:aws:s3:::other/*"), allowed
    )
    assert any("not within the allowed" in e for e in errs)


def test_unrestricted_bounds_allows_anything_not_denied():
    allowed = {"Statement": [{"Action": ["*"], "Resource": ["*"]}]}
    assert policy.validate_policy_within_bounds(stmt("dynamodb:PutItem"), allowed) == []


def test_empty_bounds_denies_all():
    errs = policy.validate_policy_within_bounds(stmt("s3:GetObject"), {"Statement": []})
    assert errs


# --- summary -------------------------------------------------------------
def test_summary_is_human_readable():
    s = policy.summarize_policy(stmt(["s3:GetObject", "s3:PutObject"], "arn:aws:s3:::mybucket/*"))
    assert "s3:GetObject" in s and "mybucket" in s


# --- read-only detection (auto-approval gate) ----------------------------
def test_is_read_only_policy_true_for_all_read_actions():
    assert policy.is_read_only_policy(stmt(["s3:GetObject", "s3:ListBucket", "ec2:DescribeInstances"]))


def test_is_read_only_policy_false_when_any_write():
    assert not policy.is_read_only_policy(stmt(["s3:GetObject", "s3:PutObject"]))


def test_is_read_only_policy_false_for_wildcard():
    assert not policy.is_read_only_policy(stmt("s3:*"))
    assert not policy.is_read_only_policy(stmt("*"))


def test_is_read_only_policy_false_for_empty():
    assert not policy.is_read_only_policy({"Statement": []})


def test_is_read_only_policy_ignores_deny_statements():
    doc = {"Statement": [
        {"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"},
        {"Effect": "Deny", "Action": "s3:DeleteObject", "Resource": "*"},
    ]}
    assert policy.is_read_only_policy(doc)


# --- covered_by_auto_policy (the auto-approve tier) ---

ASSUME = {"Version": V, "Statement": [{"Effect": "Allow",
    "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::123456789012:role/deploy-prod"}]}
AUTO_ASSUME = {"Statement": [{"Action": ["sts:AssumeRole"],
    "Resource": ["arn:aws:iam::123456789012:role/deploy-*"]}]}


def test_auto_covers_assume_role_via_glob():
    assert policy.covered_by_auto_policy(ASSUME, [], AUTO_ASSUME, [])


def test_auto_rejects_action_outside_the_superset():
    write = stmt("s3:PutObject", "arn:aws:s3:::b/*")
    assert not policy.covered_by_auto_policy(write, [], AUTO_ASSUME, [])


def test_auto_rejects_resource_outside_the_glob():
    other = {"Version": V, "Statement": [{"Effect": "Allow",
        "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::123456789012:role/admin"}]}
    assert not policy.covered_by_auto_policy(other, [], AUTO_ASSUME, [])


def test_auto_empty_tiers_never_auto():
    assert not policy.covered_by_auto_policy(ASSUME, [], None, [])
    assert not policy.covered_by_auto_policy(ASSUME, [], {"Statement": []}, [])


def test_auto_no_grants_is_not_auto():
    assert not policy.covered_by_auto_policy(None, [], AUTO_ASSUME, ["*"])


def test_auto_managed_arn_matched_by_glob():
    arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
    assert policy.covered_by_auto_policy(None, [arn], None, ["arn:aws:iam::aws:policy/ReadOnly*"])


def test_auto_managed_arn_case_sensitive():
    arn = "arn:aws:iam::123456789012:policy/MyPolicy"
    assert not policy.covered_by_auto_policy(None, [arn], None, ["arn:aws:iam::123456789012:policy/mypolicy"])


def test_auto_any_uncovered_managed_arn_blocks():
    # Coverage is all-or-nothing.
    assert not policy.covered_by_auto_policy(
        ASSUME, ["arn:aws:iam::aws:policy/AdministratorAccess"], AUTO_ASSUME, ["arn:aws:iam::aws:policy/ReadOnly*"],
    )


def test_auto_doc_plus_managed_both_covered():
    arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
    assert policy.covered_by_auto_policy(ASSUME, [arn], AUTO_ASSUME, ["arn:aws:iam::aws:policy/ReadOnly*"])
