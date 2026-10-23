"""The runtime for Scooter system tasks.

A system task is a CLI the scheduler runs on a schedule. Write one as a click command
and decorate it with `@task`, which adds the standard flags and passes a TaskContext::

    import click
    from scooter_task import TaskContext, task

    @task(name="weekly-digest")
    @click.option("--title", default="Weekly digest")
    async def main(ctx: TaskContext, title: str) -> None:
        for user in await ctx.scooter.list_users():
            await ctx.spawn(owner=user["id"], prompt="Summarise my week.", title=title)

The contract with the scheduler (env, exit codes, spawn reporting) is in
lib/py/scooter-task/README.md; nix/scooter-task.nix packages a task as `bin/<name>`.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import signal
import sys
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, TypeVar

import click
from scooter_lib.client import ScooterClient, SpawnError
from scooter_lib.logging_config import configure_logging, get_logger

__all__ = ["SpawnError", "TaskContext", "task"]

# The exit code of a run the scheduler stopped with SIGTERM (128 + 15), as a shell reports it.
EXIT_TERMINATED = 143

T = TypeVar("T")


@dataclass
class TaskContext:
    """What a task gets besides its own arguments."""

    name: str
    scooter: ScooterClient
    log: logging.LoggerAdapter
    run_id: str | None = None
    deadline: datetime | None = None
    model: str | None = None
    dry_run: bool = False
    # The conversations this run spawned, in order.
    spawned: list[str] = field(default_factory=list)
    _loop: asyncio.AbstractEventLoop | None = None

    async def spawn(
        self, *, owner: str | None, prompt: str, title: str | None = None, model: str | None = None
    ) -> str | None:
        """Open a conversation as `owner` with `source: "system"`, and record it on this run.

        Returns the conversation id, or None on a dry run. Raises SpawnError when the
        agent-host refuses; a task that fans out catches it to carry on with the rest.
        """
        model = model or self.model
        if self.dry_run:
            self.log.info("dry run: would spawn", extra={"owner": owner, "task_title": title, "model": model})
            return None
        conversation_id = await self.scooter.spawn_conversation(
            owner, prompt, title=title, model=model, source="system"
        )
        self.spawned.append(conversation_id)
        self.log.info("spawned", extra={"owner": owner, "conversation_id": conversation_id, "model": model})
        if self.run_id:
            try:
                await self.scooter.report_spawn(self.run_id, conversation_id, owner)
            except Exception as e:  # noqa: BLE001 — the conversation exists; losing the audit row must not stop the fan-out
                self.log.error(
                    "could not record the spawn on the run",
                    extra={"conversation_id": conversation_id, "error": f"{type(e).__name__}: {e}"},
                )
        return conversation_id

    def sync(self, awaitable: Awaitable[T]) -> T:
        """Run a coroutine (e.g. `ctx.spawn(...)`) from a plain-`def` task, which runs in a worker thread."""
        if self._loop is None:
            raise RuntimeError("ctx.sync is only available while the task runs")
        return asyncio.run_coroutine_threadsafe(awaitable, self._loop).result()  # type: ignore[arg-type]


class _TaskLog(logging.LoggerAdapter):
    """Binds the task name and run id, keeping the caller's own `extra=` (the stock adapter replaces it)."""

    def process(self, msg: Any, kwargs: Any) -> tuple[Any, Any]:
        kwargs["extra"] = {**(self.extra or {}), **(kwargs.get("extra") or {})}
        return msg, kwargs


def _deadline(_ctx: click.Context, _param: click.Parameter, value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError as e:
        raise click.BadParameter(f"not an ISO time: {value!r}") from e


_STANDARD = ("run_id", "deadline", "model", "dry_run")


def task(name: str | None = None, *, help: str | None = None) -> Callable[[Callable[..., Any]], click.Command]:
    """Turn `fn(ctx, **options)` (async or plain) into a click command with the standard flags."""

    def decorate(fn: Callable[..., Any]) -> click.Command:
        task_name = name or fn.__name__.replace("_", "-")

        def callback(run_id: str | None, deadline: datetime | None, model: str | None, dry_run: bool, **kw: Any) -> None:
            configure_logging("scooter-task")
            log = _TaskLog(get_logger("scooter-task", task_name), {"task": task_name, "run_id": run_id})
            code = _run(fn, task_name, log, kw, run_id=run_id, deadline=deadline, model=model or None, dry_run=dry_run)
            sys.exit(code)

        callback.__doc__ = help or fn.__doc__
        # The task's own click options, then the standard ones (click reverses the list).
        callback.__click_params__ = list(getattr(fn, "__click_params__", []))  # type: ignore[attr-defined]
        for p in callback.__click_params__:  # type: ignore[attr-defined]
            if p.name in _STANDARD:
                raise TypeError(f"task {task_name}: --{p.name.replace('_', '-')} is a standard flag")
        cmd = callback
        cmd = click.option("--dry-run", is_flag=True, help="Log what would be spawned instead of spawning.")(cmd)
        cmd = click.option("--model", envvar="SCOOTER_TASK_MODEL", help="Default model for spawned conversations.")(cmd)
        cmd = click.option(
            "--deadline", envvar="SCOOTER_TASK_DEADLINE", callback=_deadline,
            help="When the scheduler's timeout expires (ISO time).",
        )(cmd)
        cmd = click.option("--run-id", envvar="SCOOTER_TASK_RUN_ID", help="The scheduler's run id; unset for a hand run.")(cmd)
        return click.command(task_name)(cmd)

    return decorate


def _run(
    fn: Callable[..., Any],
    task_name: str,
    log: logging.LoggerAdapter,
    kw: dict[str, Any],
    **ctx_fields: Any,
) -> int:
    """Run the task to an exit code: 0 on return, 1 on an exception, 143 on SIGTERM."""

    async def main() -> None:
        loop = asyncio.get_running_loop()
        current = asyncio.current_task()
        assert current is not None
        loop.add_signal_handler(signal.SIGTERM, current.cancel)
        async with ScooterClient.from_env() as scooter:
            ctx = TaskContext(name=task_name, scooter=scooter, log=log, _loop=loop, **ctx_fields)
            if inspect.iscoroutinefunction(fn):
                await fn(ctx, **kw)
            else:
                # A thread cannot be cancelled, so a plain-def task that ignores SIGTERM is
                # left to the scheduler's SIGKILL.
                result = await asyncio.to_thread(fn, ctx, **kw)
                if inspect.isawaitable(result):
                    await result

    try:
        asyncio.run(main())
    except asyncio.CancelledError:
        print(f"{task_name}: terminated", file=sys.stderr)
        return EXIT_TERMINATED
    except click.ClickException:
        raise  # a usage error keeps click's exit code (2) and message
    except Exception as e:  # noqa: BLE001 — the one-line error is the run's recorded failure
        log.exception("task failed")
        print(f"{task_name}: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    return 0
