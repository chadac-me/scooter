"""scooter-prompt: the built-in system task that opens a conversation from a prompt.

    scooter-prompt --owner alice --prompt "Check the CI dashboard" --title "CI check"
    scooter-prompt --per-user --prompt-file ./digest.md --title "Weekly digest"

Each conversation is owned by the user it is for and recorded on the scheduler run. A
shell task can put this in its runtimeInputs to talk to Scooter without a client.
"""

from __future__ import annotations

from pathlib import Path

import click
from scooter_task import SpawnError, TaskContext, task


@task(name="scooter-prompt")
@click.option("--owner", "owners", multiple=True, help="Open a conversation as this user (repeatable).")
@click.option("--per-user", is_flag=True, help="Open one conversation for every user the agent-host knows.")
@click.option("--prompt", help="The prompt.")
@click.option("--prompt-file", type=click.Path(exists=True, dir_okay=False), help="Read the prompt from a file.")
@click.option("--title", help="The conversations' title.")
async def main(
    ctx: TaskContext,
    owners: tuple[str, ...],
    per_user: bool,
    prompt: str | None,
    prompt_file: str | None,
    title: str | None,
) -> None:
    """Open a conversation for one or more users from a prompt."""
    if (prompt is None) == (prompt_file is None):
        raise click.UsageError("give exactly one of --prompt and --prompt-file")
    if bool(owners) == per_user:
        raise click.UsageError("give --owner or --per-user")
    text = prompt if prompt is not None else Path(prompt_file).read_text()  # type: ignore[arg-type]

    targets = list(owners) or [u["id"] for u in await ctx.scooter.list_users() if u.get("id")]
    failed: list[str] = []
    for owner in targets:
        try:
            await ctx.spawn(owner=owner, prompt=text, title=title)
        except SpawnError as e:
            # One user's failure must not cost everyone after them their conversation.
            ctx.log.error("spawn failed", extra={"owner": owner, "error": str(e)})
            failed.append(owner)
    if failed:
        raise RuntimeError(f"{len(failed)} of {len(targets)} spawns failed")
