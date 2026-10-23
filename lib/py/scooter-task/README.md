# scooter-task

The runtime for Scooter **system tasks**: recurring jobs the scheduler runs as a
subprocess (`scooter.systemTasks.<id>`). A task is any executable. This package is
the well-paved way to write one in Python, and `nix/scooter-task.nix`
(`mkScooterTask`) packages it as `bin/<name>`.

```python
import click
from scooter_task import TaskContext, task

@task(name="weekly-digest")
@click.option("--title", default="Weekly digest")
async def main(ctx: TaskContext, title: str) -> None:
    for user in await ctx.scooter.list_users():
        await ctx.spawn(owner=user["id"], prompt="Summarise my week.", title=title)
```

`@task` adds the standard flags, each with the env var the scheduler sets, so a hand run
and a scheduled run behave the same:

| Flag | Env | Meaning |
|---|---|---|
| `--run-id` | `SCOOTER_TASK_RUN_ID` | the scheduler's run id; unset for a hand run |
| `--deadline` | `SCOOTER_TASK_DEADLINE` | when the timeout expires (ISO time) |
| `--model` | `SCOOTER_TASK_MODEL` | default model for `ctx.spawn` |
| `--dry-run` | | `ctx.spawn` logs instead of spawning |

`TaskContext` carries `scooter` (a `scooter_lib.client.ScooterClient` built from the
environment: `.spawn_conversation`, `.list_users`, and `.broker`, an `httpx.AsyncClient`
on `BROKER_URL`), `spawn(...)`, `run_id`, `deadline`, `dry_run`, `model` and `log`. A
plain `def` task runs in a worker thread and calls coroutines through `ctx.sync(...)`.

## The task contract

What the scheduler relies on, whatever language a task is written in:

| | |
|---|---|
| **Invocation** | `command args…`, working directory `/tmp/task-<run id>` |
| **Environment** | `SCOOTER_TASK_ID`, `SCOOTER_TASK_RUN_ID`, `SCOOTER_TASK_DEADLINE`, `SCOOTER_TASK_MODEL`, `AGENT_HOST_URL`, `BROKER_URL`, `SCHEDULER_URL`, `SCOOTER_TOKEN_PATH` (the projected service-account token) |
| **Exit code** | 0 = succeeded; anything else = failed; killed at the timeout = timed out (`@task` exits 143 on SIGTERM) |
| **Output** | stdout and stderr go to the scheduler's log; the last 4 KiB of stderr is a failed run's error, so end with a one-line reason (`@task` prints `<name>: <Error>: <message>`) |
| **Spawns** | to record a conversation on the run, `POST $SCHEDULER_URL/runs/$SCOOTER_TASK_RUN_ID/conversations` with `{conversation_id, owner}` and the token. `ctx.spawn` and `scooter-prompt` do this |

A conversation spawned with `source: "system"` is owned by the user it was opened for.
