"""refresh-profile: the hourly system task that spawns one analysis conversation per
user who is due.

Sketch against the PR 3 `scooter-task` runtime (design, "Writing a task"); it does not
import yet. The 10-day cadence is per user: most hourly runs spawn nothing.
"""

from __future__ import annotations

# TODO(PR 3): from scooter_task import task, TaskContext
from pathlib import Path


def main() -> None:  # pragma: no cover - placeholder until PR 3
    raise SystemExit("refresh-profile needs the scooter-task runtime (system tasks, PR 3)")


# The intended body, once `@task` exists:
#
# @task(name="refresh-profile")
# def refresh(ctx: TaskContext, *, prompt_file: Path, interval: str, max_spawns: int) -> None:
#     due = ctx.broker.get("/personalization/system/eligible",
#                          params={"interval": interval, "limit": max_spawns})["owners"]
#     prompt = prompt_file.read_text()
#     for owner in due:
#         if ctx.dry_run:
#             ctx.log.info("would spawn", extra={"owner": owner})
#             continue
#         conv = ctx.scooter.spawn_conversation(owner=owner, prompt=prompt, source="system")
#         ctx.report_spawn(conv)
#         ctx.broker.post("/personalization/system/spawned",
#                         json={"owner": owner, "conversation_id": conv.id})
