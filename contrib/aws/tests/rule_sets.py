"""The shipped rule sets as rules.nix compiles them."""

from __future__ import annotations

READ_ONLY_VERBS = (
    "Get", "List", "Describe", "Head", "BatchGet", "Lookup", "Search", "Query", "Scan", "Select",
    "Check", "Detect", "Discover", "Fetch", "Preview", "Read", "Test", "Validate", "Verify",
)


def _rule(name, effect, actions=(), resources=("*",), arns=(), approvers=None):
    return {
        "name": name, "effect": effect, "actions": list(actions), "resources": list(resources),
        "managed_policy_arns": list(arns), "approvers": approvers,
    }


BLOCKED = [
    _rule("blocked/iam-escalation", "deny", [
        "iam:CreateUser", "iam:CreateRole", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:CreateAccessKey",
        "iam:UpdateAssumeRolePolicy", "iam:PutRolePermissionsBoundary",
        "iam:DeleteRolePermissionsBoundary", "iam:PassRole",
    ]),
    _rule("blocked/audit-tampering", "deny", [
        "cloudtrail:DeleteTrail", "cloudtrail:StopLogging", "cloudtrail:UpdateTrail",
        "guardduty:Delete*", "guardduty:Disable*", "guardduty:DisassociateFromMasterAccount",
        "securityhub:Delete*", "securityhub:Disable*", "config:Delete*", "config:Stop*",
    ]),
    _rule("blocked/organization", "deny", ["organizations:LeaveOrganization", "account:CloseAccount"]),
    _rule("blocked/encryption", "deny", ["kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:Delete*"]),
]

SECRETS_GUARD = [
    _rule("secrets-guard/secret-values", "require",
          ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue"]),
    _rule("secrets-guard/ssm-params", "require",
          ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]),
    _rule("secrets-guard/kms-decrypt", "require", ["kms:Decrypt"]),
]

READ_ONLY = [_rule(f"read-only/{v.lower()}", "allow", [f"*:{v}*"]) for v in READ_ONLY_VERBS]

GRANTS = {"name": "grants", "anchor": True}


def compiled(*, before=(), after=(), read_only=False):
    """Default sets plus rules before/after the anchor, in order."""
    return [*BLOCKED, *before, *SECRETS_GUARD, GRANTS, *after, *(READ_ONLY if read_only else ())]


rule = _rule
