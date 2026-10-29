"""GitHub's agent tools: comment on the conversation's PR or issue, and summarise a PR."""

from __future__ import annotations

import logging

from fastmcp import FastMCP

from scooter_broker_lib.links import first_target, ref_of, resource_type_is
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate
from scooter_broker_lib.refs import GithubTarget, parse_github_resource_id

from .pr_summary import fetch_pr_summary

logger = logging.getLogger(__name__)

mcp = FastMCP(name="github")

SOURCE = "github"


def _target_from_link(link: dict) -> GithubTarget | None:
    """A link's target from its structured `ref`, else from its URL; the two are never mixed, since a link posted through the agent-host API carries only url+title."""
    ref = ref_of(link)
    owner, repo, number = ref.get("owner"), ref.get("repo"), ref.get("number")
    if owner and repo and number is not None:
        return GithubTarget(owner=owner, repo=repo, number=int(number))
    return parse_github_resource_id(link.get("url") or "")


async def github_target(ctx: ToolContext) -> GithubTarget | None:
    """The PR/issue this conversation is attached to, or None; shared by the gate and the handler."""
    return first_target(await ctx.links.list(), SOURCE, _target_from_link)


async def _github_attached(ctx: ToolContext) -> bool:
    return await github_target(ctx) is not None


async def _thread_is_resolved(
    ctx: ToolContext, target: GithubTarget, comment_id: int
) -> bool:
    """Whether the review thread containing `comment_id` is resolved, via GraphQL since REST does not expose it; fails open so the reply still posts."""
    query = """query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          reviewThreads(first:100){ nodes { isResolved comments(first:100){ nodes { databaseId } } } }
        }
      }
    }"""
    try:
        response = await ctx.upstream.request(
            "POST",
            "graphql",
            json={
                "query": query,
                "variables": {
                    "owner": target.owner,
                    "repo": target.repo,
                    "number": target.number,
                },
            },
        )
        if not 200 <= response.status_code < 300:
            return False
        threads = (
            (response.json() or {})
            .get("data", {})
            .get("repository", {})
            .get("pullRequest", {})
            .get("reviewThreads", {})
            .get("nodes")
            or []
        )
        for thread in threads:
            ids = [c.get("databaseId") for c in (thread.get("comments", {}).get("nodes") or [])]
            if comment_id in ids:
                return thread.get("isResolved") is True
        return False
    except Exception:
        logger.warning(
            "could not check whether the review thread is resolved; posting anyway",
            extra={"comment_id": comment_id},
            exc_info=True,
        )
        return False


@gate(_github_attached)
@mcp.tool
async def github_comment(
    body: str,
    in_reply_to: int | None = None,
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """Post a comment on THIS conversation's GitHub PR/issue.

    owner/repo/number are inferred. Pass `in_reply_to` (a review-comment id) to reply
    within a PR review thread; omit it for a PR-level comment. Returns the real result.
    """
    target = await github_target(ctx)
    if target is None:
        return ToolResult.error(
            "Could not determine the GitHub PR/issue for this conversation — it has no "
            "github link with owner/repo/number. Use the broker's /github proxy with an "
            "explicit owner/repo/number instead."
        )
    if in_reply_to is not None:
        # GitHub sends no webhook when a human resolves a review thread, so a late reply could land on a closed one.
        if await _thread_is_resolved(ctx, target, in_reply_to):
            return ToolResult.error(
                f"That review thread (comment {in_reply_to}) has been RESOLVED, so the "
                "reply was not posted — it would be noise on a closed conversation. If "
                "you still need to say something, post it as a PR-level comment "
                "(github_comment without in_reply_to)."
            )
    base = f"repos/{target.owner}/{target.repo}"
    path = (
        f"{base}/pulls/{target.number}/comments/{in_reply_to}/replies"
        if in_reply_to
        else f"{base}/issues/{target.number}/comments"
    )
    response = await ctx.upstream.request("POST", path, json={"body": body})
    return ToolResult.from_upstream(response, success_text="Commented on the GitHub PR/issue.")


_PR_TYPES = ("pr", "pull", "pulls", "pull_request", "pull_requests")
_ISSUE_TYPES = ("issue", "issues")


def _pr_target_from_link(link: dict) -> GithubTarget | None:
    """A link's target unless the link is known to be an issue."""
    if resource_type_is(str(link.get("resourceType") or ""), truthy=_ISSUE_TYPES, falsy=_PR_TYPES):
        return None
    if "/issues/" in (link.get("url") or ""):
        return None
    return _target_from_link(link)


async def github_pr_target(ctx: ToolContext) -> GithubTarget | None:
    """The conversation's oldest linked PR, skipping linked issues."""
    return first_target(await ctx.links.list(), SOURCE, _pr_target_from_link)


@mcp.tool
async def github_pr_summary(
    pr: str | None = None,
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """One-call status of a GitHub pull request. Check it before reporting on a PR.

    Shows state (open/merged/closed), DRAFT status, mergeability and conflicts, the
    review decision (who approved, who requested changes, who is still requested), CI
    on the head commit (failing and pending checks named), the comment count, and
    review threads. Each UNRESOLVED thread is listed with its comment_id, which
    github_comment takes as `in_reply_to`. The last line lists what blocks the merge.

    Use it to keep track of your own PRs: before marking a draft ready for review,
    before saying a PR is done or green, and when picking work back up.

    `pr` is a PR URL or `owner/repo#123`. Omit it for the PR this conversation is
    linked to.
    """
    if pr:
        target = parse_github_resource_id(pr.strip())
        if target is None:
            return ToolResult.error(
                f"Could not parse {pr!r} as a GitHub PR. Pass a PR URL "
                "(https://github.com/owner/repo/pull/123) or `owner/repo#123`."
            )
    else:
        target = await github_pr_target(ctx)
        if target is None:
            return ToolResult.error(
                "This conversation has no linked GitHub PR. Pass `pr` explicitly, as a "
                "PR URL or `owner/repo#123`."
            )
    return await fetch_pr_summary(ctx.upstream, target)


def github_mcp_server() -> FastMCP:
    return mcp
