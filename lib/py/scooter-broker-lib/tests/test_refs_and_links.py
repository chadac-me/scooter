"""The URL/id parsers and the link-resolution mechanics, which return None rather than guess."""

from __future__ import annotations

import pytest

from scooter_broker_lib.links import first_target, links_for, ref_of, resource_type_is
from scooter_broker_lib.refs import (
    parse_github_resource_id,
    parse_github_url,
    parse_gitlab_resource_id,
    parse_gitlab_url,
    parse_jira_url,
)


# --- github -----------------------------------------------------------------------

@pytest.mark.parametrize("url,expected", [
    ("https://github.com/o/r/pull/7", ("o", "r", 7)),
    ("https://github.com/o/r/issues/7", ("o", "r", 7)),
    ("https://github.com/o/r/pull/7/files", ("o", "r", 7)),
    ("https://github.com/o/r/pull/7#issuecomment-1", ("o", "r", 7)),
    # The host is not checked, so Enterprise installs work.
    ("https://github.acme.internal/o/r/pull/7", ("o", "r", 7)),
])
def test_github_urls_parse(url, expected):
    t = parse_github_url(url)
    assert (t.owner, t.repo, t.number) == expected


@pytest.mark.parametrize("url", [
    None, "", "not a url", "ftp://github.com/o/r/pull/7",
    "https://github.com/o/r/commits/7",      # wrong kind
    "https://github.com/o/r/pull/abc",       # non-numeric
    "https://github.com/o/r",                # too short
])
def test_github_non_targets_return_none(url):
    assert parse_github_url(url) is None


def test_github_resource_id_accepts_both_shapes():
    """One resource, two spellings: conversation_map holds `o/r#7`, resource_links holds the html_url."""
    short = parse_github_resource_id("o/r#7")
    url = parse_github_resource_id("https://github.com/o/r/pull/7")
    assert (short.owner, short.repo, short.number) == ("o", "r", 7)
    assert (url.owner, url.repo, url.number) == ("o", "r", 7)


# --- gitlab -----------------------------------------------------------------------

@pytest.mark.parametrize("url,expected", [
    ("https://gitlab.com/g/p/-/merge_requests/3", ("g/p", "3", True)),
    ("https://gitlab.com/g/p/-/issues/3", ("g/p", "3", False)),
    # The /-/ separator is optional.
    ("https://gitlab.com/g/p/merge_requests/3", ("g/p", "3", True)),
    # Subgroups nest arbitrarily.
    ("https://gitlab.com/g/sub/deeper/p/-/merge_requests/3", ("g/sub/deeper/p", "3", True)),
])
def test_gitlab_urls_parse(url, expected):
    t = parse_gitlab_url(url)
    assert (t.project_id, t.iid, t.is_mr) == expected


@pytest.mark.parametrize("url", [
    None, "", "https://gitlab.com/g/-/merge_requests/3",   # needs namespace/project
    "https://gitlab.com/g/p/-/merge_requests/abc",
    "https://gitlab.com/g/p/-/merge_requests",             # no iid
])
def test_gitlab_non_targets_return_none(url):
    assert parse_gitlab_url(url) is None


def test_gitlab_resource_id_shapes():
    mr = parse_gitlab_resource_id("g/p!3")
    issue = parse_gitlab_resource_id("g/p#3")
    assert (mr.project_id, mr.iid, mr.is_mr) == ("g/p", "3", True)
    assert (issue.project_id, issue.iid, issue.is_mr) == ("g/p", "3", False)


def test_gitlab_resource_id_tries_the_URL_first():
    """A web_url ending in a `#<n>` fragment would otherwise match `<repo>#<iid>`."""
    t = parse_gitlab_resource_id("https://gitlab.com/g/p/-/merge_requests/3#note_9")
    assert t.project_id == "g/p"
    assert t.is_mr is True


# --- jira -------------------------------------------------------------------------

def test_jira_url_parses_and_upcases_the_key():
    assert parse_jira_url("https://acme.atlassian.net/browse/eng-12").issue_key == "ENG-12"


@pytest.mark.parametrize("url", [
    None, "", "https://acme.atlassian.net/projects/ENG",
    "https://acme.atlassian.net/browse/notakey",
    "https://acme.atlassian.net/browse",
])
def test_jira_non_targets_return_none(url):
    assert parse_jira_url(url) is None


# --- the link mechanics -----------------------------------------------------------

def _link(source="github", **over):
    return {"source": source, "resourceType": "pr", "url": "", "ref": {}, **over}


def test_links_for_preserves_order_which_is_OLDEST_FIRST():
    """listLinks orders by insert id, so the resource the conversation was started from stays first."""
    rows = [_link(url="first"), _link(source="slack"), _link(url="second")]
    assert [l["url"] for l in links_for(rows, "github")] == ["first", "second"]


def test_ref_of_is_always_a_mapping():
    assert ref_of({"ref": None}) == {}
    assert ref_of({}) == {}
    assert ref_of({"ref": {"a": 1}}) == {"a": 1}


def test_first_target_takes_the_FIRST_complete_one():
    rows = [_link(url="a"), _link(url="b")]
    assert first_target(rows, "github", lambda l: l["url"] or None) == "a"


def test_first_target_SKIPS_an_incomplete_link_without_mixing_fields():
    """Fields are never mixed across links."""
    rows = [_link(url=""), _link(url="real")]
    assert first_target(rows, "github", lambda l: l["url"] or None) == "real"


def test_first_target_returns_none_when_nothing_resolves():
    assert first_target([_link(url="")], "github", lambda l: l["url"] or None) is None


def test_first_target_ignores_other_sources():
    assert first_target([_link(source="gitlab", url="x")], "github", lambda l: l["url"] or None) is None


@pytest.mark.parametrize("spelling,expected", [
    ("merge_request", True), ("mr", True), ("MERGE_REQUESTS", True),
    ("issue", False), ("issues", False),
    ("something_else", None), ("", None),
])
def test_resource_type_is_refuses_to_guess(spelling, expected):
    """An unrecognised spelling returns None so the caller falls back to something it trusts."""
    assert resource_type_is(spelling, truthy=("merge_request", "merge_requests", "mr"),
                            falsy=("issue", "issues")) is expected


# --- the conversation_map fallback shapes -----------------------------
# The broker turns each conversation_map row into a link whose `url` carries the raw resource_id, so the parsers must accept both shapes.

@pytest.mark.parametrize("raw,expected", [
    ("o/r#7", ("o", "r", 7)),
    ("https://github.com/o/r/pull/7", ("o", "r", 7)),
])
def test_one_github_call_covers_both_row_shapes(raw, expected):
    t = parse_github_resource_id(raw)
    assert (t.owner, t.repo, t.number) == expected


@pytest.mark.parametrize("raw,expected", [
    ("g/p!3", ("g/p", "3", True)),
    ("g/p#3", ("g/p", "3", False)),
    ("https://gitlab.com/g/p/-/merge_requests/3", ("g/p", "3", True)),
])
def test_one_gitlab_call_covers_both_row_shapes(raw, expected):
    t = parse_gitlab_resource_id(raw)
    assert (t.project_id, t.iid, t.is_mr) == expected


def test_a_github_resource_id_that_is_neither_shape_is_none():
    """A garbage mapping row is skipped rather than resolving to a wrong target."""
    assert parse_github_resource_id("not-a-resource") is None
