"""echo's system task: the fixture for `contribs.<name>.systemTasks`.

It opens one conversation for every user the agent-host knows. With ``--dry-run`` it
only logs them.
"""

from __future__ import annotations

import click
from scooter_task import TaskContext, task


@task(name="echo-greet")
@click.option("--greeting", default="Hello from a system task.", help="The prompt each conversation opens with.")
async def main(ctx: TaskContext, greeting: str) -> None:
    """Open a conversation for every user, prompted with --greeting."""
    for user in await ctx.scooter.list_users():
        if user.get("id"):
            await ctx.spawn(owner=user["id"], prompt=greeting, title="Echo greeting")
