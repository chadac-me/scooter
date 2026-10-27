"""refresh-profile: the hourly system task that spawns one analysis conversation per
user who is due. The cadence is per user (--interval), so most runs spawn nothing.
"""

from __future__ import annotations

from pathlib import Path

import click
from scooter_task import SpawnError, TaskContext, task

from .. import REFRESH_TITLE


@task(name="refresh-profile")
@click.option("--prompt-file", type=click.Path(exists=True, dir_okay=False, path_type=Path), required=True)
@click.option("--interval", default="10d", help="How long after a user's last analysis they are due again.")
@click.option("--max-spawns", type=click.IntRange(min=1), default=25, help="At most this many conversations a run.")
async def main(ctx: TaskContext, prompt_file: Path, interval: str, max_spawns: int) -> None:
    """Open an analysis conversation for each user due a profile refresh."""
    broker = ctx.scooter.broker
    r = await broker.get("/personalization/system/eligible", params={"interval": interval, "limit": max_spawns})
    r.raise_for_status()
    due: list[str] = r.json()["owners"]
    ctx.log.info("users due a refresh", extra={"count": len(due)})
    prompt = prompt_file.read_text()
    failed = 0
    for owner in due:
        try:
            conv = await ctx.spawn(owner=owner, prompt=prompt, title=REFRESH_TITLE)
        except SpawnError as e:
            # Left requested, so the next run retries this user.
            failed += 1
            ctx.log.error("spawn failed", extra={"owner": owner, "error": str(e)})
            continue
        if conv is None:
            continue
        r = await broker.post("/personalization/system/spawned", json={"owner": owner, "conversation_id": conv})
        r.raise_for_status()
    if failed:
        raise SystemExit(f"{failed} of {len(due)} spawns failed")
