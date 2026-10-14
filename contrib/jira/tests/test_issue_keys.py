"""Jira's issue-key grammar, exported for the integrations that reference tickets."""

from __future__ import annotations

from scooter_contrib_jira.issue_keys import extract_issue_keys


def test_finds_keys_across_several_texts_first_mention_first():
    assert extract_issue_keys("ENG-42: fix it", "branch/ENG-7-thing", "see ENG-42 again") == [
        "ENG-42",
        "ENG-7",
    ]


def test_ignores_text_that_is_not_a_key():
    assert extract_issue_keys("no ticket here", "lowercase-12", "") == []


def test_a_zero_suffix_is_not_a_ticket():
    # Jira numbers start at 1, so RELEASE-0 and v2-0 are version-ish strings.
    assert extract_issue_keys("RELEASE-0", "BUILD-000") == []
    assert extract_issue_keys("ENG-10") == ["ENG-10"]


def test_handles_none_ish_text_without_raising():
    assert extract_issue_keys("", "ENG-1") == ["ENG-1"]


def test_project_keys_may_contain_digits():
    assert extract_issue_keys("A1B2-3 is the ticket") == ["A1B2-3"]
