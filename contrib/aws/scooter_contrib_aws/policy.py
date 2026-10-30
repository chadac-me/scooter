"""IAM policy guardrails: validate, bound-check, classify, summarize.

Pure functions gating every request: structural and prod-account checks, then
per-account allowlist coverage. The `deny` approval rules (rules.py) replace the
old global deny list, and the permission boundary on every dynamic role (see
iam.py) is the AWS-enforced ceiling on top.
"""

from __future__ import annotations

import fnmatch
import re

from .models import RiskLevel

# Read verbs: drive risk and prod checks, not approval.
READ_ONLY_PREFIXES = (
    "Get", "List", "Describe", "Head", "BatchGet",
    "Lookup", "Search", "Query", "Scan", "Select",
    "Check", "Detect", "Discover", "Fetch", "Preview",
    "Read", "Test", "Validate", "Verify",
)

MAX_STATEMENTS = 20


def _is_read_only_action(action: str) -> bool:
    parts = action.split(":", 1)
    if len(parts) != 2:
        return False
    verb = parts[1]
    return any(verb.startswith(prefix) for prefix in READ_ONLY_PREFIXES)


def _normalize_actions(actions: str | list[str]) -> list[str]:
    return [actions] if isinstance(actions, str) else actions


def _normalize_resources(resources: str | list[str]) -> list[str]:
    return [resources] if isinstance(resources, str) else resources


def _is_prod_account(target_account: str) -> bool:
    return any(m in target_account.lower() for m in ("production", "prod"))


def validate_policy(policy_document: dict, target_account: str = "") -> list[str]:
    """Structural and prod-account checks, returning error strings."""
    errors: list[str] = []
    is_prod = _is_prod_account(target_account)

    if policy_document.get("Version") != "2012-10-17":
        errors.append("Policy Version must be '2012-10-17'")

    statements = policy_document.get("Statement", [])
    if not statements:
        errors.append("Policy must contain at least one Statement")
        return errors

    if len(statements) > MAX_STATEMENTS:
        errors.append(f"Policy exceeds maximum of {MAX_STATEMENTS} statements")

    for i, stmt in enumerate(statements, 1):
        prefix = f"Statement {i}"

        effect = stmt.get("Effect", "")
        if effect != "Allow":
            errors.append(f"{prefix}: Only 'Allow' effect is supported (got '{effect}')")
            continue

        actions = _normalize_actions(stmt.get("Action", []))
        if not actions:
            errors.append(f"{prefix}: Action is required")
            continue

        resources = _normalize_resources(stmt.get("Resource", []))
        if not resources:
            errors.append(f"{prefix}: Resource is required")

        has_write = any(not _is_read_only_action(a) for a in actions)
        if has_write and is_prod:
            for resource in resources:
                if resource == "*":
                    errors.append(
                        f"{prefix}: Resource '*' is not allowed for write actions in "
                        "production. Specify explicit resource ARNs."
                    )

        for action in actions:
            if action == "*":
                errors.append(f"{prefix}: Action '*' (full wildcard) is not allowed")
            elif (
                is_prod
                and ":" in action
                and action.split(":")[1] == "*"
                and not _is_read_only_action(action)
            ):
                service = action.split(":")[0]
                errors.append(
                    f"{prefix}: Action '{action}' is too broad for production. "
                    f"Specify individual {service} actions."
                )

    return errors


def classify_risk(policy_document: dict, target_account: str) -> RiskLevel:
    """prod+write is HIGH, write or prod is MEDIUM, else LOW; drives the STS duration."""
    is_prod = _is_prod_account(target_account)
    has_write = False
    for stmt in policy_document.get("Statement", []):
        actions = _normalize_actions(stmt.get("Action", []))
        if any(not _is_read_only_action(a) for a in actions):
            has_write = True
            break
    if is_prod and has_write:
        return RiskLevel.HIGH
    if has_write or is_prod:
        return RiskLevel.MEDIUM
    return RiskLevel.LOW


def validate_policy_within_bounds(policy_document: dict, allowed_policy: dict) -> list[str]:
    """Layer 3: every requested action and resource must be covered by the account's allowed_policy (fnmatch patterns)."""
    allowed_stmts = allowed_policy.get("Statement", [])
    if not allowed_stmts:
        return ["Account has no allowed_policy statements — all requests denied"]

    errors: list[str] = []
    for i, stmt in enumerate(policy_document.get("Statement", []), 1):
        actions = _normalize_actions(stmt.get("Action", []))
        resources = _normalize_resources(stmt.get("Resource", []))
        for action in actions:
            if not _action_covered_by_bounds(action, resources, allowed_stmts):
                errors.append(
                    f"Statement {i}: Action '{action}' is not within the allowed "
                    "permissions for this account"
                )
    return errors


def _action_covered_by_bounds(action: str, resources: list[str], allowed_stmts: list[dict]) -> bool:
    for allowed_stmt in allowed_stmts:
        allowed_actions = _normalize_actions(allowed_stmt.get("Action", []))
        allowed_resources = _normalize_resources(allowed_stmt.get("Resource", []))
        if not _pattern_list_covers(allowed_actions, action):
            continue
        if all(_pattern_list_covers(allowed_resources, r) for r in resources):
            return True
    return False


def _pattern_list_covers(patterns: list[str], value: str) -> bool:
    """Case-insensitive fnmatch; "*" covers everything."""
    value_lower = value.lower()
    return any(fnmatch.fnmatch(value_lower, p.lower()) for p in patterns)


def summarize_policy(policy_document: dict) -> str:
    """A one-line summary of the policy for the approval UI."""
    parts: list[str] = []
    for stmt in policy_document.get("Statement", []):
        actions = _normalize_actions(stmt.get("Action", []))
        resources = _normalize_resources(stmt.get("Resource", []))
        action_str = ", ".join(actions[:3])
        if len(actions) > 3:
            action_str += f" (+{len(actions) - 3} more)"
        resource_names = []
        for r in resources[:3]:
            match = re.search(r"arn:aws:[^:]+:[^:]*:[^:]*:(.+)", r)
            resource_names.append(match.group(1) if match else r)
        resource_str = ", ".join(resource_names)
        if len(resources) > 3:
            resource_str += f" (+{len(resources) - 3} more)"
        parts.append(f"{action_str} on {resource_str}")
    return "; ".join(parts)


def write_actions(policy_document: dict) -> list[str]:
    """Every Allow action that is not read-only, in first-seen order."""
    out: list[str] = []
    for stmt in policy_document.get("Statement", []):
        if stmt.get("Effect", "Allow") != "Allow":
            continue
        for a in _normalize_actions(stmt.get("Action", [])):
            if not _is_read_only_action(a) and a not in out:
                out.append(a)
    return out
