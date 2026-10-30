"""Approval rules: deny a request, grant it, or name its approvers."""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Iterable

from .objects import aws_account_object

EFFECTS = ("allow", "require", "require_always", "deny")
REQUIRES = ("require", "require_always")

# Obligation name for parts no single rule covers.
ACCOUNT_DEFAULT = "account default"


@dataclass(frozen=True)
class Rule:
    name: str
    effect: str
    actions: tuple[str, ...] = ()
    resources: tuple[str, ...] = ("*",)
    managed_policy_arns: tuple[str, ...] = ()
    approvers: tuple[str, ...] | None = None


def parse_rules(raw: Iterable[dict]) -> list[Rule]:
    """The registry's rules minus anchors; ValueError when malformed."""
    out: list[Rule] = []
    for r in raw:
        if r.get("anchor"):
            continue
        name = r.get("name") or "?"
        effect = r.get("effect")
        if effect not in EFFECTS:
            raise ValueError(f"approval rule '{name}': unknown effect {effect!r}")
        actions = tuple(r.get("actions") or ())
        arns = tuple(r.get("managed_policy_arns") or ())
        if bool(actions) == bool(arns):
            raise ValueError(f"approval rule '{name}': set exactly one of actions and managed_policy_arns")
        approvers = r.get("approvers")
        out.append(Rule(
            name=name,
            effect=effect,
            actions=actions,
            resources=tuple(r.get("resources") or ("*",)),
            managed_policy_arns=arns,
            approvers=tuple(approvers) if approvers is not None else None,
        ))
    return out


# --- glob algebra ----------------------------------------------------------

def _opaque(p: str) -> bool:
    return "[" in p or "]" in p


@lru_cache(maxsize=4096)
def glob_overlaps(p: str, q: str) -> bool:
    """Could some string match both globs? Brackets fail closed."""
    if _opaque(p) or _opaque(q):
        return True

    @lru_cache(maxsize=None)
    def go(i: int, j: int) -> bool:
        if i == len(p):
            return all(c == "*" for c in q[j:])
        if j == len(q):
            return all(c == "*" for c in p[i:])
        if p[i] == "*":
            return go(i + 1, j) or go(i, j + 1)
        if q[j] == "*":
            return go(i, j + 1) or go(i + 1, j)
        return (p[i] == q[j] or "?" in (p[i], q[j])) and go(i + 1, j + 1)

    return go(0, 0)


@lru_cache(maxsize=4096)
def glob_covers(rule: str, req: str) -> bool:
    """Does `rule` match everything `req` does? Brackets fail closed."""
    if _opaque(rule) or _opaque(req):
        return False

    @lru_cache(maxsize=None)
    def go(i: int, j: int) -> bool:
        if i == len(rule):
            return j == len(req)
        if rule[i] == "*":
            return go(i + 1, j) or (j < len(req) and go(i, j + 1))
        if j == len(req):
            return False
        if rule[i] == "?":
            return req[j] != "*" and go(i + 1, j + 1)
        return rule[i] == req[j] and go(i + 1, j + 1)

    return go(0, 0)


def _split_action(a: str) -> tuple[str, str]:
    a = a.lower()
    if ":" in a:
        svc, verb = a.split(":", 1)
        return svc, verb
    return (a, "*") if set(a) <= {"*"} else (a, "")


def action_overlaps(rule: str, req: str) -> bool:
    (rs, rv), (qs, qv) = _split_action(rule), _split_action(req)
    return glob_overlaps(rs, qs) and glob_overlaps(rv, qv)


def action_covers(rule: str, req: str) -> bool:
    (rs, rv), (qs, qv) = _split_action(rule), _split_action(req)
    return glob_covers(rs, qs) and glob_covers(rv, qv)


# --- parts of a request ----------------------------------------------------

@dataclass(frozen=True)
class Part:
    """One (action, resource) pair, or one managed-policy ARN."""

    action: str = ""
    resource: str = ""
    arn: str = ""

    def label(self) -> str:
        return self.arn or f"{self.action} on {self.resource}"


def request_parts(policy_document: dict | None, managed_policy_arns: Iterable[str]) -> list[Part]:
    parts: list[Part] = []
    for stmt in (policy_document or {}).get("Statement", []):
        if stmt.get("Effect", "Allow") != "Allow":
            continue
        actions = stmt.get("Action", [])
        resources = stmt.get("Resource", ["*"])
        for a in [actions] if isinstance(actions, str) else actions:
            for r in [resources] if isinstance(resources, str) else resources:
                parts.append(Part(action=a, resource=r))
    parts += [Part(arn=a) for a in managed_policy_arns]
    return parts


def _overlaps(rule: Rule, part: Part) -> bool:
    if part.arn:
        # ARNs are case-sensitive, unlike actions and resources.
        return any(fnmatch.fnmatchcase(part.arn, p) for p in rule.managed_policy_arns)
    return any(action_overlaps(a, part.action) for a in rule.actions) and any(
        glob_overlaps(r.lower(), part.resource.lower()) for r in rule.resources
    )


def _covers(rule: Rule, part: Part) -> bool:
    if part.arn:
        return _overlaps(rule, part)
    return any(action_covers(a, part.action) for a in rule.actions) and any(
        glob_covers(r.lower(), part.resource.lower()) for r in rule.resources
    )


def _contains_rule(outer: Rule, inner: Rule) -> bool:
    """Does `outer` match every request `inner` matches?"""
    if inner.managed_policy_arns:
        return all(any(glob_covers(o, i) for o in outer.managed_policy_arns) for i in inner.managed_policy_arns)
    return all(any(action_covers(o, i) for o in outer.actions) for i in inner.actions) and all(
        any(glob_covers(o.lower(), i.lower()) for o in outer.resources) for i in inner.resources
    )


# --- the decision ----------------------------------------------------------

def denials(rules: list[Rule], parts: list[Part]) -> list[str]:
    """An error per part overlapping any `deny` rule."""
    errors: list[str] = []
    for part in parts:
        for rule in rules:
            if rule.effect == "deny" and _overlaps(rule, part):
                errors.append(f"'{part.label()}' is blocked by approval rule '{rule.name}'")
                break
    return errors


def walk(rules: list[Rule], part: Part) -> tuple[list[Rule], bool]:
    """The require rules hit, and whether an allow covered `part`."""
    hits: list[Rule] = []
    covered = False
    for rule in rules:
        if rule.effect == "deny" or not _overlaps(rule, part):
            continue
        if rule.effect == "require_always":
            hits.append(rule)
        elif covered:
            continue
        elif rule.effect == "require":
            hits.append(rule)
        elif rule.effect == "allow" and _covers(rule, part):
            covered = True
    return hits, covered


@dataclass
class Obligation:
    """One approval needed from anyone eligible on any FGA object."""

    id: str
    rules: list[str]
    objects: list[str]
    parts: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {"id": self.id, "rules": self.rules, "objects": self.objects, "parts": self.parts}

    @classmethod
    def from_json(cls, d: dict) -> "Obligation":
        return cls(id=d["id"], rules=list(d["rules"]), objects=list(d["objects"]), parts=list(d.get("parts", [])))


def rule_object(account: str, rule: Rule) -> str:
    """The rule's own FGA object if it names approvers, else the account's."""
    if rule.approvers is None:
        return aws_account_object(account)
    return aws_account_object(f"{account}/{rule.name}")


def obligations(account: str, rules: list[Rule], parts: list[Part]) -> list[Obligation]:
    """The approvals a request needs; empty means auto-granted."""
    acct_obj = aws_account_object(account)
    # Eligible objects -> (rule names, part labels).
    found: dict[frozenset[str], tuple[list[str], list[str]]] = {}

    def add(objects: set[str], rule_name: str, part: Part) -> None:
        names, labels = found.setdefault(frozenset(objects), ([], []))
        if rule_name not in names:
            names.append(rule_name)
        if part.label() not in labels:
            labels.append(part.label())

    for part in parts:
        hits, covered = walk(rules, part)
        for r in hits:
            eligible = {rule_object(account, r)}
            if r.effect != "require_always":
                # ANY: hits containing r's part may approve it too.
                eligible |= {
                    rule_object(account, h) for h in hits
                    if h is not r and (_covers(h, part) or _contains_rule(h, r))
                }
            add(eligible, r.name, part)
        if not covered and not any(_covers(h, part) for h in hits):
            add({acct_obj}, ACCOUNT_DEFAULT, part)

    # Drop obligations whose eligible set contains another's.
    keys = list(found)
    kept = [k for k in keys if not any(o < k for o in keys)]
    return [
        Obligation(id=str(i), rules=found[k][0], objects=sorted(k), parts=found[k][1])
        for i, k in enumerate(kept)
    ]


def rule_approver_tuples(account: str, rules: list[Rule]) -> list[tuple[str, str]]:
    """(approver, FGA object) for rules naming their own approvers."""
    return [(a, rule_object(account, r)) for r in rules if r.approvers is not None for a in r.approvers]
