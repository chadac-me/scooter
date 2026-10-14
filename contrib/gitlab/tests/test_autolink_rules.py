"""GitLab's auto-link rules: which proxied calls produce a conversation link."""

from __future__ import annotations

from scooter_broker_lib.autolink import Link

from scooter_contrib_gitlab.broker_provider import _GITLAB_LINK_RULES


def _match(rules, method: str, path: str):
    return next((r for r in rules if r.matches(method, path)), None)


def test_gitlab_mr_rule():
    # The path includes the api/v4 prefix because the upstream is the bare host.
    r = _match(_GITLAB_LINK_RULES, "POST", "api/v4/projects/42/merge_requests")
    assert r.extract({"web_url": "https://gitlab.com/acme/app/-/merge_requests/9", "title": "MR"}) == Link(
        "gitlab", "mr", "https://gitlab.com/acme/app/-/merge_requests/9", "MR"
    )


def test_gitlab_encoded_project_path_matches():
    assert _match(_GITLAB_LINK_RULES, "POST", "api/v4/projects/acme%2Fapp/issues") is not None


def test_gitlab_rule_does_not_match_the_old_prefixless_path():
    assert _match(_GITLAB_LINK_RULES, "POST", "projects/42/merge_requests") is None
