"""A GitHub PR's state, reviews, CI and conversation, fetched in one GraphQL query and rendered as text."""

from __future__ import annotations

from typing import Any

from scooter_broker_lib.mcp import ToolResult, UpstreamCaller
from scooter_broker_lib.refs import GithubTarget

# Unresolved threads listed by name; the rest are counted.
MAX_LISTED_THREADS = 20
MAX_LISTED_CHECKS = 15

QUERY = """query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      title url state isDraft merged mergedAt closedAt
      mergeable mergeStateStatus reviewDecision
      author{login}
      baseRefName headRefName headRefOid
      additions deletions changedFiles
      autoMergeRequest{mergeMethod}
      labels(first:20){nodes{name}}
      comments{totalCount}
      latestOpinionatedReviews(first:50){nodes{state author{login}}}
      reviewRequests(first:20){nodes{requestedReviewer{
        __typename
        ... on User{login} ... on Bot{login} ... on Mannequin{login} ... on Team{slug}
      }}}
      reviewThreads(first:100){
        totalCount
        nodes{
          isResolved isOutdated path line
          comments(first:1){totalCount nodes{databaseId body author{login}}}
        }
      }
      commits(last:1){nodes{commit{statusCheckRollup{
        state
        contexts(first:100){
          totalCount
          nodes{
            __typename
            ... on CheckRun{name status conclusion detailsUrl}
            ... on StatusContext{context state targetUrl}
          }
        }
      }}}}
    }
  }
}"""

_PASSED = {"SUCCESS"}
_SKIPPED = {"NEUTRAL", "SKIPPED"}


async def fetch_pr_summary(upstream: UpstreamCaller, target: GithubTarget) -> ToolResult:
    """Fetch and render the PR, surfacing an upstream or GraphQL error verbatim."""
    response = await upstream.request(
        "POST",
        "graphql",
        json={
            "query": QUERY,
            "variables": {"owner": target.owner, "repo": target.repo, "number": target.number},
        },
    )
    if not 200 <= response.status_code < 300:
        return ToolResult.from_upstream(response, success_text="")
    try:
        payload = response.json() or {}
    except ValueError:
        return ToolResult.error(f"GitHub returned a non-JSON response:\n{response.text}")
    pr = ((payload.get("data") or {}).get("repository") or {}).get("pullRequest")
    if not pr:
        messages = "; ".join(e.get("message", "") for e in payload.get("errors") or []) or "no data"
        return ToolResult.error(
            f"Could not read {_ref(target)} as a pull request (it may be an issue, or "
            f"not exist): {messages}"
        )
    return ToolResult.ok(render(target, pr))


def render(target: GithubTarget, pr: dict[str, Any]) -> str:
    """The summary text; `pr` is the GraphQL `pullRequest` object."""
    head = (pr.get("headRefOid") or "")[:7]
    lines = [
        f'{_ref(target)} "{pr.get("title", "")}" by @{_login(pr.get("author"))}',
        pr.get("url") or "",
        f"State: {_state(pr)}",
        f"Branch: {pr.get('headRefName')} -> {pr.get('baseRefName')}, head {head} "
        f"(+{pr.get('additions', 0)} -{pr.get('deletions', 0)}, {pr.get('changedFiles', 0)} files)",
    ]
    is_open = pr.get("state") == "OPEN"
    if is_open:
        merge = f"Merge: {pr.get('mergeable')} (merge state {pr.get('mergeStateStatus')})"
        auto = pr.get("autoMergeRequest")
        if auto:
            merge += f"; auto-merge on ({auto.get('mergeMethod', '').lower()})"
        lines.append(merge)

    review_line, changes_requested = _reviews(pr)
    lines.append(review_line)

    checks = _checks(pr)
    lines.extend(checks.lines(head))

    threads = _threads(pr)
    lines.extend(threads.lines(pr))

    labels = [n.get("name") for n in (pr.get("labels") or {}).get("nodes") or []]
    if labels:
        lines.append(f"Labels: {', '.join(labels)}")

    if is_open:
        blockers = []
        if pr.get("isDraft"):
            blockers.append("draft")
        if pr.get("mergeable") == "CONFLICTING":
            blockers.append("merge conflicts")
        if pr.get("mergeStateStatus") == "BEHIND":
            blockers.append("behind base branch")
        if checks.failed:
            blockers.append(f"{len(checks.failed)} failing check(s)")
        if checks.pending:
            blockers.append(f"{len(checks.pending)} pending check(s)")
        if changes_requested:
            blockers.append("changes requested")
        elif pr.get("reviewDecision") == "REVIEW_REQUIRED":
            blockers.append("review required")
        if threads.unresolved:
            blockers.append(f"{len(threads.unresolved)} unresolved thread(s)")
        lines.append(f"Blockers: {', '.join(blockers) if blockers else 'none'}")
    return "\n".join(line for line in lines if line)


def _ref(target: GithubTarget) -> str:
    return f"{target.owner}/{target.repo}#{target.number}"


def _login(actor: dict[str, Any] | None) -> str:
    return (actor or {}).get("login") or "ghost"


def _state(pr: dict[str, Any]) -> str:
    if pr.get("merged"):
        return f"MERGED at {pr.get('mergedAt')}"
    if pr.get("state") == "CLOSED":
        return f"CLOSED (not merged) at {pr.get('closedAt')}"
    return "OPEN, DRAFT" if pr.get("isDraft") else "OPEN, ready for review"


def _reviews(pr: dict[str, Any]) -> tuple[str, bool]:
    by_state: dict[str, list[str]] = {}
    for review in (pr.get("latestOpinionatedReviews") or {}).get("nodes") or []:
        by_state.setdefault(review.get("state", ""), []).append("@" + _login(review.get("author")))
    awaiting = []
    for req in (pr.get("reviewRequests") or {}).get("nodes") or []:
        who = req.get("requestedReviewer") or {}
        awaiting.append(f"team {who['slug']}" if who.get("slug") else "@" + _login(who))
    parts = [f"Reviews: {pr.get('reviewDecision') or 'no review required'}"]
    for label, state in (("approved", "APPROVED"), ("changes requested", "CHANGES_REQUESTED")):
        if by_state.get(state):
            parts.append(f"{label} by {', '.join(by_state[state])}")
    if awaiting:
        parts.append(f"awaiting {', '.join(awaiting)}")
    elif not by_state:
        parts.append("no reviewers requested")
    return "; ".join(parts), bool(by_state.get("CHANGES_REQUESTED"))


class _Checks:
    def __init__(self, rollup: dict[str, Any] | None):
        self.rollup = rollup
        self.passed: list[str] = []
        self.skipped: list[str] = []
        self.failed: list[str] = []
        self.pending: list[str] = []
        self.total = 0
        if not rollup:
            return
        contexts = rollup.get("contexts") or {}
        self.total = contexts.get("totalCount") or 0
        for node in contexts.get("nodes") or []:
            if node.get("__typename") == "StatusContext":
                name, url, state = node.get("context"), node.get("targetUrl"), node.get("state")
                bucket = (
                    self.passed if state == "SUCCESS"
                    else self.pending if state in ("PENDING", "EXPECTED")
                    else self.failed
                )
            else:
                name, url = node.get("name"), node.get("detailsUrl")
                status, conclusion = node.get("status"), node.get("conclusion")
                state = conclusion if status == "COMPLETED" else status
                bucket = (
                    self.pending if status != "COMPLETED"
                    else self.passed if conclusion in _PASSED
                    else self.skipped if conclusion in _SKIPPED
                    else self.failed
                )
            bucket.append(f"{name} ({state})" + (f" {url}" if url and bucket is self.failed else ""))

    def lines(self, head: str) -> list[str]:
        if not self.rollup:
            return [f"CI ({head}): no checks reported"]
        counts = ", ".join(
            f"{len(group)} {label}"
            for label, group in (
                ("failed", self.failed), ("pending", self.pending),
                ("passed", self.passed), ("skipped", self.skipped),
            )
            if group
        )
        out = [f"CI ({head}): {self.rollup.get('state')}. {self.total} checks: {counts}"]
        seen = len(self.passed) + len(self.skipped) + len(self.failed) + len(self.pending)
        if self.total > seen:
            out[0] += f" (first {seen} classified)"
        for label, group in (("failed", self.failed), ("pending", self.pending)):
            out.extend(f"  {label}: {item}" for item in group[:MAX_LISTED_CHECKS])
            if len(group) > MAX_LISTED_CHECKS:
                out.append(f"  ...and {len(group) - MAX_LISTED_CHECKS} more {label}")
        return out


def _checks(pr: dict[str, Any]) -> _Checks:
    commits = (pr.get("commits") or {}).get("nodes") or []
    commit = (commits[0].get("commit") if commits else None) or {}
    return _Checks(commit.get("statusCheckRollup"))


class _Threads:
    def __init__(self, threads: dict[str, Any]):
        self.total = threads.get("totalCount") or 0
        self.nodes = threads.get("nodes") or []
        self.unresolved = [t for t in self.nodes if not t.get("isResolved")]
        self.review_comments = sum((t.get("comments") or {}).get("totalCount") or 0 for t in self.nodes)

    def lines(self, pr: dict[str, Any]) -> list[str]:
        comments = (pr.get("comments") or {}).get("totalCount") or 0
        outdated = sum(1 for t in self.unresolved if t.get("isOutdated"))
        head = (
            f"Conversation: {comments} comment(s); {self.review_comments} review comment(s) "
            f"in {self.total} thread(s), {len(self.unresolved)} unresolved"
        )
        if outdated:
            head += f" ({outdated} on outdated code)"
        if self.total > len(self.nodes):
            head += f" (first {len(self.nodes)} threads read)"
        out = [head]
        for thread in self.unresolved[:MAX_LISTED_THREADS]:
            out.append("  unresolved: " + _thread_line(thread))
        if len(self.unresolved) > MAX_LISTED_THREADS:
            out.append(f"  ...and {len(self.unresolved) - MAX_LISTED_THREADS} more unresolved")
        return out


def _threads(pr: dict[str, Any]) -> _Threads:
    return _Threads(pr.get("reviewThreads") or {})


def _thread_line(thread: dict[str, Any]) -> str:
    comments = thread.get("comments") or {}
    first = (comments.get("nodes") or [{}])[0]
    where = thread.get("path") or "?"
    if thread.get("line"):
        where += f":{thread['line']}"
    body = " ".join((first.get("body") or "").split())
    if len(body) > 100:
        body = body[:97] + "..."
    outdated = ", outdated" if thread.get("isOutdated") else ""
    return (
        f"{where} @{_login(first.get('author'))} (comment_id {first.get('databaseId')}, "
        f"{comments.get('totalCount', 0)} comment(s){outdated}): \"{body}\""
    )
