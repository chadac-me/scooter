"""Linked-resource URL -> the structured target a reply tool needs.

A link row may carry a structured `ref` or only url+title, so a tool must parse the
URL. The parsers look only at the path shape (the link's `source` names the provider
and self-hosted installs have arbitrary hosts) and return None rather than guess,
since a wrong target comments on someone else's PR.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import unquote, urlparse


@dataclass(frozen=True)
class GithubTarget:
    owner: str
    repo: str
    number: int


@dataclass(frozen=True)
class GitlabTarget:
    # The project path, which GitLab accepts URL-encoded in place of the numeric id.
    project_id: str
    iid: str
    is_mr: bool


@dataclass(frozen=True)
class JiraTarget:
    issue_key: str


_DIGITS = re.compile(r"^\d+$")
# Exported because jira's conversation_map resource_id is a bare key.
ISSUE_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*-\d+$")
_ISSUE_KEY = ISSUE_KEY_RE


def _segments(url: str | None) -> list[str] | None:
    """Path segments of an http(s) URL, percent-decoded, or None."""
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https"):
        return None
    return [unquote(s) for s in parsed.path.split("/") if s]


def parse_github_url(url: str | None) -> GithubTarget | None:
    """`https://<host>/<owner>/<repo>/(pull|issues)/<number>` with any suffix, host unchecked."""
    segs = _segments(url)
    if not segs or len(segs) < 4:
        return None
    owner, repo, kind, num = segs[0], segs[1], segs[2], segs[3]
    if kind not in ("pull", "pulls", "issues", "issue"):
        return None
    if not _DIGITS.match(num):
        return None
    return GithubTarget(owner=owner, repo=repo, number=int(num))


def parse_gitlab_url(url: str | None) -> GitlabTarget | None:
    """`https://<host>/<group>/…/<project>/-/(merge_requests|issues)/<iid>`, where the kind segment splits project from iid because `/-/` is optional and subgroups nest."""
    segs = _segments(url)
    if not segs:
        return None
    at = next((i for i, s in enumerate(segs) if s in ("merge_requests", "issues")), -1)
    if at < 1:
        return None
    if at + 1 >= len(segs):
        return None
    iid = segs[at + 1]
    if not _DIGITS.match(iid):
        return None
    path = [s for s in segs[:at] if s != "-"]
    if len(path) < 2:
        return None
    return GitlabTarget(project_id="/".join(path), iid=iid, is_mr=segs[at] == "merge_requests")


def parse_jira_url(url: str | None) -> JiraTarget | None:
    """`https://<site>/browse/<KEY-123>`."""
    segs = _segments(url)
    if not segs:
        return None
    try:
        at = segs.index("browse")
    except ValueError:
        return None
    if at + 1 >= len(segs):
        return None
    key = segs[at + 1]
    if not _ISSUE_KEY.match(key):
        return None
    return JiraTarget(issue_key=key.upper())


# --- the conversation_map `resource_id` shapes ------------------------------------
# The webhooks handlers' own `_resource_id()` spellings, accepted alongside the html_url form.

_GITHUB_SHORT = re.compile(r"^([^/]+)/(.+)#(\d+)$")
_GITLAB_MR = re.compile(r"^(.+)!(\d+)$")
_GITLAB_ISSUE = re.compile(r"^(.+)#(\d+)$")


def parse_github_resource_id(resource_id: str) -> GithubTarget | None:
    """`<owner>/<repo>#<number>`, or the html_url form."""
    m = _GITHUB_SHORT.match(resource_id or "")
    if m:
        return GithubTarget(owner=m.group(1), repo=m.group(2), number=int(m.group(3)))
    return parse_github_url(resource_id)


def parse_gitlab_resource_id(resource_id: str) -> GitlabTarget | None:
    """`<repo>!<iid>` (MR) or `<repo>#<iid>` (issue), or a web_url, tried first because a `#<n>` fragment would otherwise match the issue shape."""
    from_url = parse_gitlab_url(resource_id)
    if from_url:
        return from_url
    mr = _GITLAB_MR.match(resource_id or "")
    if mr:
        return GitlabTarget(project_id=mr.group(1), iid=mr.group(2), is_mr=True)
    issue = _GITLAB_ISSUE.match(resource_id or "")
    if issue:
        return GitlabTarget(project_id=issue.group(1), iid=issue.group(2), is_mr=False)
    return None
