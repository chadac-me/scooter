"""A GitLab MR's state, approvals, pipeline and discussions, fetched over REST and rendered as text."""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote

import httpx

from scooter_broker_lib.mcp import ToolResult, UpstreamCaller
from scooter_broker_lib.refs import GitlabTarget

MAX_LISTED_THREADS = 20
MAX_LISTED_JOBS = 15

_PENDING_JOBS = {"created", "pending", "running", "waiting_for_resource", "preparing", "scheduled"}


async def fetch_mr_summary(upstream: UpstreamCaller, target: GitlabTarget) -> ToolResult:
    """Fetch and render the MR; only the MR read itself is fatal, the rest degrade to a note."""
    base = f"api/v4/projects/{quote(target.project_id, safe='')}/merge_requests/{target.iid}"
    mr_resp = await upstream.request("GET", base)
    if not 200 <= mr_resp.status_code < 300:
        return ToolResult.from_upstream(mr_resp, success_text="")
    mr = mr_resp.json() or {}
    pipeline = mr.get("head_pipeline") or {}

    async def jobs() -> httpx.Response | None:
        if not pipeline.get("id"):
            return None
        project = quote(target.project_id, safe="")
        return await upstream.request(
            "GET", f"api/v4/projects/{project}/pipelines/{pipeline['id']}/jobs",
            params={"per_page": 100},
        )

    approvals, discussions, job_list = await asyncio.gather(
        upstream.request("GET", f"{base}/approvals"),
        upstream.request("GET", f"{base}/discussions", params={"per_page": 100}),
        jobs(),
    )
    return ToolResult.ok(render(target, mr, approvals, discussions, job_list))


def render(
    target: GitlabTarget,
    mr: dict[str, Any],
    approvals: httpx.Response,
    discussions: httpx.Response,
    jobs: httpx.Response | None,
) -> str:
    sha = (mr.get("sha") or "")[:8]
    state = mr.get("state")
    is_open = state == "opened"
    lines = [
        f'{target.project_id}!{target.iid} "{mr.get("title", "")}" by @{_user(mr.get("author"))}',
        mr.get("web_url") or "",
        f"State: {_state(mr)}",
        f"Branch: {mr.get('source_branch')} -> {mr.get('target_branch')}, head {sha} "
        f"({mr.get('changes_count') or '?'} files changed)",
    ]
    if is_open:
        merge = f"Merge: {mr.get('detailed_merge_status') or mr.get('merge_status')}"
        if mr.get("has_conflicts"):
            merge += ", HAS CONFLICTS"
        if mr.get("merge_when_pipeline_succeeds"):
            merge += "; set to auto-merge when the pipeline succeeds"
        lines.append(merge)

    approvals_left, review_line = _approvals(mr, approvals)
    lines.append(review_line)

    pipeline = mr.get("head_pipeline") or {}
    failed, pending, ci_lines = _pipeline(pipeline, sha, jobs)
    lines.extend(ci_lines)

    unresolved, thread_lines = _discussions(mr, discussions)
    lines.extend(thread_lines)

    if mr.get("labels"):
        lines.append(f"Labels: {', '.join(mr['labels'])}")

    if is_open:
        blockers = []
        if mr.get("draft") or mr.get("work_in_progress"):
            blockers.append("draft")
        if mr.get("has_conflicts"):
            blockers.append("merge conflicts")
        if mr.get("detailed_merge_status") == "need_rebase":
            blockers.append("needs rebase")
        status = pipeline.get("status")
        if status in ("failed", "canceled"):
            blockers.append(f"pipeline {status}" + (f" ({failed} failing job(s))" if failed else ""))
        elif status in _PENDING_JOBS or pending:
            blockers.append("pipeline still running")
        if approvals_left:
            blockers.append(f"{approvals_left} approval(s) needed")
        if unresolved:
            blockers.append(f"{unresolved} unresolved thread(s)")
        lines.append(f"Blockers: {', '.join(blockers) if blockers else 'none'}")
    return "\n".join(line for line in lines if line)


def _user(user: dict[str, Any] | None) -> str:
    return (user or {}).get("username") or "unknown"


def _state(mr: dict[str, Any]) -> str:
    state = mr.get("state")
    if state == "merged":
        return f"MERGED at {mr.get('merged_at')}"
    if state in ("closed", "locked"):
        return f"{state.upper()} (not merged) at {mr.get('closed_at')}"
    return "OPEN, DRAFT" if mr.get("draft") or mr.get("work_in_progress") else "OPEN, ready for review"


def _unavailable(what: str, resp: httpx.Response) -> str:
    return f"{what}: unavailable (HTTP {resp.status_code}: {resp.text[:200]})"


def _approvals(mr: dict[str, Any], resp: httpx.Response) -> tuple[int, str]:
    """Approvals left, and the review line."""
    reviewers = ", ".join("@" + _user(r) for r in mr.get("reviewers") or [])
    tail = f"; reviewers {reviewers}" if reviewers else "; no reviewers assigned"
    if not 200 <= resp.status_code < 300:
        return 0, _unavailable("Approvals", resp) + tail
    data = resp.json() or {}
    approved_by = [_user(a.get("user")) for a in data.get("approved_by") or []]
    left = data.get("approvals_left") or 0
    parts = [f"Approvals: {'approved' if data.get('approved') else 'not approved'}"]
    if approved_by:
        parts.append("approved by " + ", ".join("@" + u for u in approved_by))
    if data.get("approvals_required"):
        parts.append(f"{left} of {data['approvals_required']} required approval(s) left")
    return left, "; ".join(parts) + tail


def _pipeline(
    pipeline: dict[str, Any], sha: str, resp: httpx.Response | None
) -> tuple[int, int, list[str]]:
    """Failed and pending job counts, and the CI lines."""
    if not pipeline:
        return 0, 0, [f"CI ({sha}): no pipeline"]
    head = f"CI ({sha}): pipeline {pipeline.get('status')} {pipeline.get('web_url') or ''}".rstrip()
    if resp is None:
        return 0, 0, [head]
    if not 200 <= resp.status_code < 300:
        return 0, 0, [head, "  " + _unavailable("jobs", resp)]
    jobs = resp.json() or []
    failed = [j for j in jobs if j.get("status") == "failed" and not j.get("allow_failure")]
    allowed = [j for j in jobs if j.get("status") == "failed" and j.get("allow_failure")]
    pending = [j for j in jobs if j.get("status") in _PENDING_JOBS]
    manual = [j for j in jobs if j.get("status") == "manual"]
    passed = [j for j in jobs if j.get("status") == "success"]
    counts = ", ".join(
        f"{len(group)} {label}"
        for label, group in (
            ("failed", failed), ("pending", pending), ("passed", passed),
            ("allowed to fail", allowed), ("manual", manual),
        )
        if group
    )
    lines = [f"{head}. {len(jobs)} jobs: {counts}" if jobs else head]
    if resp.headers.get("x-next-page"):
        lines[0] += f" (first {len(jobs)} read)"
    for label, group in (("failed", failed), ("pending", pending)):
        for job in group[:MAX_LISTED_JOBS]:
            url = f" {job['web_url']}" if label == "failed" and job.get("web_url") else ""
            lines.append(f"  {label}: {job.get('name')} [{job.get('stage')}] ({job.get('status')}){url}")
        if len(group) > MAX_LISTED_JOBS:
            lines.append(f"  ...and {len(group) - MAX_LISTED_JOBS} more {label}")
    return len(failed), len(pending), lines


def _discussions(mr: dict[str, Any], resp: httpx.Response) -> tuple[int, list[str]]:
    """The unresolved thread count, and the conversation lines."""
    notes = mr.get("user_notes_count") or 0
    if not 200 <= resp.status_code < 300:
        return 0, [f"Conversation: {notes} comment(s)", "  " + _unavailable("discussions", resp)]
    threads = [
        d for d in resp.json() or []
        if any(n.get("resolvable") for n in d.get("notes") or [])
    ]
    unresolved = [
        d for d in threads
        if any(n.get("resolvable") and not n.get("resolved") for n in d.get("notes") or [])
    ]
    head = f"Conversation: {notes} comment(s); {len(threads)} thread(s), {len(unresolved)} unresolved"
    if resp.headers.get("x-next-page"):
        head += " (first page of discussions read)"
    lines = [head]
    for d in unresolved[:MAX_LISTED_THREADS]:
        lines.append("  unresolved: " + _thread_line(d))
    if len(unresolved) > MAX_LISTED_THREADS:
        lines.append(f"  ...and {len(unresolved) - MAX_LISTED_THREADS} more unresolved")
    return len(unresolved), lines


def _thread_line(discussion: dict[str, Any]) -> str:
    notes = discussion.get("notes") or []
    first = notes[0] if notes else {}
    position = first.get("position") or {}
    where = position.get("new_path") or position.get("old_path") or "MR"
    line = position.get("new_line") or position.get("old_line")
    if line:
        where += f":{line}"
    body = " ".join((first.get("body") or "").split())
    if len(body) > 100:
        body = body[:97] + "..."
    return (
        f"{where} @{_user(first.get('author'))} (discussion_id {discussion.get('id')}, "
        f"{len(notes)} note(s)): \"{body}\""
    )
