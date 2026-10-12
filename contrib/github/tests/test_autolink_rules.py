"""GitHub's auto-link rules: which proxied calls produce a conversation link."""

from __future__ import annotations

from scooter_broker_lib.autolink import Link

from scooter_contrib_github.broker_provider import _GITHUB_LINK_RULES


def _match(rules, method: str, path: str):
    return next((r for r in rules if r.matches(method, path)), None)


def test_github_pr_rule():
    r = _match(_GITHUB_LINK_RULES, "POST", "repos/acme/app/pulls")
    assert r is not None
    link = r.extract({"html_url": "https://github.com/acme/app/pull/7", "title": "Add X"})
    assert link == Link("github", "pr", "https://github.com/acme/app/pull/7", "Add X")


def test_github_issue_rule():
    r = _match(_GITHUB_LINK_RULES, "POST", "repos/acme/app/issues")
    assert r is not None
    assert r.extract({"html_url": "https://github.com/acme/app/issues/3", "title": "Bug"}).resource_type == "issue"


def test_github_rules_do_not_match_reads_or_comments():
    assert _match(_GITHUB_LINK_RULES, "GET", "repos/acme/app/pulls") is None
    assert _match(_GITHUB_LINK_RULES, "POST", "repos/acme/app/issues/3/comments") is None
