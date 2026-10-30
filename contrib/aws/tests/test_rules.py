"""The approval-rule engine: globs, deny, the walk, obligations."""

from __future__ import annotations

import pytest

from rule_sets import compiled, rule
from scooter_contrib_aws import rules
from scooter_contrib_aws.rules import Part, action_covers, action_overlaps, glob_covers, glob_overlaps


# --- glob algebra ----------------------------------------------------------
@pytest.mark.parametrize("p,q,want", [
    ("abc", "abc", True),
    ("a*", "*c", True),
    ("a*", "b*", False),
    ("a?c", "abc", True),
    ("a?c", "ac", False),
    ("*", "", True),
    ("get*", "*value", True),
    ("[ab]", "zzz", True),  # brackets fail closed
])
def test_glob_overlaps(p, q, want):
    assert glob_overlaps(p, q) is want


@pytest.mark.parametrize("rule_glob,req,want", [
    ("get*", "getobject", True),
    ("get*", "get*", True),
    ("get*", "g*", False),
    ("*", "*", True),
    ("?", "*", False),  # a rule `?` doesn't cover a request `*`
    ("?", "a", True),
    ("a*b", "a*b", True),
    ("[ab]", "a", False),  # brackets fail closed
])
def test_glob_covers(rule_glob, req, want):
    assert glob_covers(rule_glob, req) is want


def test_actions_match_service_and_verb_separately():
    assert not action_covers("s3:?", "s3:*")
    # `*` can't swallow the colon.
    assert not action_overlaps("kms:Delete*", "*:GetSecret*")
    assert action_overlaps("kms:Delete*", "kms:*")
    assert action_covers("*:Get*", "S3:GETOBJECT")  # case-insensitive


# --- deny ------------------------------------------------------------------
DEFAULT = rules.parse_rules(compiled(read_only=True))


def parts(*actions, resource="*"):
    return [Part(action=a, resource=resource) for a in actions]


@pytest.mark.parametrize("action", [
    "iam:CreateRole", "iam:PassRole", "guardduty:DeletePublishingDestination",
    "KMS:ScheduleKeyDeletion", "kms:*", "iam:*", "*:Delete*",
])
def test_blocked_set_denies_any_overlap(action):
    errs = rules.denials(DEFAULT, parts(action))
    assert errs and "blocked/" in errs[0]


def test_deny_ignores_order_and_allows():
    rs = rules.parse_rules([rule("a", "allow", ["kms:*"]), rule("d", "deny", ["kms:Delete*"])])
    assert rules.denials(rs, parts("kms:*"))
    assert not rules.denials(rs, parts("kms:Decrypt"))


# --- the walk -------------------------------------------
SECTION3 = rules.parse_rules(compiled(
    before=[rule("dev-secrets/dev", "allow", ["secretsmanager:GetSecretValue"],
                 ["arn:aws:secretsmanager:*:*:secret:dev/*"])],
    read_only=True,
))


@pytest.mark.parametrize("action,resource,needs", [
    ("secretsmanager:GetSecretValue", "arn:aws:secretsmanager:us-east-1:1:secret:dev/db", []),
    ("secretsmanager:GetSecretValue", "*", [["secrets-guard/secret-values"]]),
    ("secretsmanager:Get*", "*", [["secrets-guard/secret-values"]]),
    ("*:GetSecret*", "*", [["secrets-guard/secret-values"]]),
    ("secretsmanager:GetResourcePolicy", "*", []),
    ("s3:GetObject", "*", []),
    ("s3:*", "*", [[rules.ACCOUNT_DEFAULT]]),
    ("ec2:StartInstances", "*", [[rules.ACCOUNT_DEFAULT]]),
])
def test_walk_table(action, resource, needs):
    got = rules.obligations("acct", SECTION3, [Part(action=action, resource=resource)])
    assert [o.rules for o in got] == needs


def test_a_kms_decrypt_carve_back_before_the_guard_allows_it():
    rs = rules.parse_rules(compiled(
        before=[rule("kms-decrypt/allow-decrypt", "allow", ["kms:Decrypt"])], read_only=True,
    ))
    assert rules.obligations("acct", rs, parts("kms:Decrypt")) == []


def test_require_always_is_never_shadowed_by_an_earlier_allow():
    rs = rules.parse_rules([
        rule("carve", "allow", ["s3:GetObject"]),
        rule("always", "require_always", ["s3:Get*"], approvers=["sec"]),
    ])
    assert [o.rules for o in rules.obligations("acct", rs, parts("s3:GetObject"))] == [["always"]]


# --- obligations ----------------------------------------
def section4(always=False):
    return rules.parse_rules([
        rule("secrets", "require_always" if always else "require",
             ["secretsmanager:GetSecretValue"], approvers=["security"]),
        rule("prod-sm", "require", ["secretsmanager:*"], ["prod/*"], approvers=["prod-oncall"]),
        rule("sm-get", "require", ["secretsmanager:Get*"], approvers=["platform"]),
    ])


def groups(always, action, resource):
    obs = rules.obligations("acct", section4(always), [Part(action=action, resource=resource)])
    return [sorted(o.split("/")[-1].split(":")[-1] for o in ob.objects) for ob in obs]


@pytest.mark.parametrize("always,action,resource,want", [
    (False, "secretsmanager:GetSecretValue", "prod/db", [["prod-sm", "secrets", "sm-get"]]),
    (False, "secretsmanager:GetSecretValue", "dev/db", [["secrets", "sm-get"]]),
    (False, "secretsmanager:Get*", "dev/db", [["sm-get"]]),
    (False, "secretsmanager:*", "*", [["prod-sm"], ["sm-get"], ["acct"]]),
    (True, "secretsmanager:Get*", "dev/db", [["secrets"], ["sm-get"]]),
    (True, "secretsmanager:GetSecretValue", "prod/db", [["secrets"]]),
])
def test_obligation_table(always, action, resource, want):
    assert groups(always, action, resource) == want


def test_rules_without_approvers_use_the_account_object():
    rs = rules.parse_rules([rule("g", "require", ["s3:*"])])
    (o,) = rules.obligations("prod", rs, parts("s3:GetObject"))
    assert o.objects == ["aws_account:prod"]


def test_rule_approver_tuples_cover_only_rules_with_their_own_approvers():
    assert rules.rule_approver_tuples("prod", section4()) == [
        ("security", "aws_account:prod/secrets"),
        ("prod-oncall", "aws_account:prod/prod-sm"),
        ("platform", "aws_account:prod/sm-get"),
    ]


# --- managed-policy ARNs ---------------------------------------------------
ARN_RULES = rules.parse_rules(compiled(after=[
    rule("ro-arns", "allow", arns=["arn:aws:iam::aws:policy/ReadOnly*"]),
    rule("assume", "allow", ["sts:AssumeRole"], ["arn:aws:iam::1:role/deploy-*"]),
]))


def test_managed_arn_matched_by_glob_is_allowed():
    assert rules.obligations("a", ARN_RULES, [Part(arn="arn:aws:iam::aws:policy/ReadOnlyAccess")]) == []


def test_managed_arn_match_is_case_sensitive():
    assert rules.obligations("a", ARN_RULES, [Part(arn="arn:aws:iam::aws:policy/readonlyaccess")])


def test_any_uncovered_part_needs_a_human():
    req = rules.request_parts(
        {"Statement": [{"Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::1:role/deploy-x"}]},
        ["arn:aws:iam::aws:policy/AdministratorAccess"],
    )
    (o,) = rules.obligations("a", ARN_RULES, req)
    assert o.parts == ["arn:aws:iam::aws:policy/AdministratorAccess"]


# --- parsing ---------------------------------------------------------------
def test_parse_skips_the_anchor_and_rejects_bad_rules():
    assert [r.name for r in rules.parse_rules([{"name": "grants", "anchor": True}, rule("x", "allow", ["a:b"])])] == ["x"]
    with pytest.raises(ValueError):
        rules.parse_rules([rule("x", "maybe", ["a:b"])])
    with pytest.raises(ValueError):
        rules.parse_rules([rule("x", "allow")])
