"""gitlab uses jira's key grammar through its pure-text module only, never jira's handler, settings or store."""

from __future__ import annotations

from scooter_contrib_gitlab import webhooks_handler as gitlab_h


def test_gitlab_uses_jiras_extractor():
    from scooter_contrib_jira.issue_keys import extract_issue_keys

    assert gitlab_h.extract_issue_keys is extract_issue_keys


def test_gitlab_carries_no_jira_regex_of_its_own():
    source = __import__("inspect").getsource(gitlab_h)
    assert "JIRA_KEY_RE" not in source


def test_the_dependency_is_the_text_module_only():
    # Importing gitlab's handler must not pull jira's router in as a side effect.
    import sys

    assert "scooter_contrib_jira.issue_keys" in sys.modules
    assert "scooter_contrib_jira.webhooks_handler" not in sys.modules
