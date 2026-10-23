"""System tasks: load the deployment's list, then run each due one as a subprocess.

`modules/scheduler.nix` renders `scooter.systemTasks` into system-tasks.json, which
`load` reads and `Store.sync_system_tasks` mirrors into `scheduled_tasks`. A due task runs
as `command args…` under the contract in lib/py/scooter-task/README.md: at most one run per
task, at most `system_task_concurrency` runs at once, SIGTERM at the timeout and SIGKILL a
grace period later, and every output line logged with the task and run ids.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import json
import os
import secrets
import shutil
import signal
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import settings
from .logging_config import get_logger
from .metrics import MetricsSink
from .models import TaskRow
from .store import SYSTEM_PREFIX, Store, SystemTaskSpec

logger = get_logger("systasks")

# A failed run keeps this much of the end of its stderr as its error.
STDERR_TAIL_BYTES = 4096


class InvalidTaskList(ValueError):
    """system-tasks.json is not the shape modules/scheduler.nix renders."""


def load(path: str) -> list[SystemTaskSpec]:
    """Read system-tasks.json; a missing file means no system tasks.

    A task whose command is not an executable file here (an operator's own derivation
    against a published image, or a hand-edited ConfigMap) is kept with `unavailable` set,
    logged, and never run, so one bad entry cannot stop the rest or the user tasks."""
    p = Path(path)
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text())
        specs = [
            SystemTaskSpec(
                id=str(t["id"]),
                command=str(t["command"]),
                args=[str(a) for a in t.get("args") or []],
                cron=t.get("cron"),
                timezone=t.get("timezone") or "UTC",
                interval_seconds=t.get("interval_seconds"),
                timeout_seconds=int(t["timeout_seconds"]),
                model=t.get("model"),
            )
            for t in raw
        ]
    except (ValueError, KeyError, TypeError) as e:
        raise InvalidTaskList(f"{path}: {type(e).__name__}: {e}") from e

    checked = []
    for spec in specs:
        if (spec.cron is None) == (spec.interval_seconds is None):
            raise InvalidTaskList(f"{path}: task {spec.id!r} needs exactly one of cron and interval_seconds")
        reason = _unavailable(spec.command)
        if reason:
            logger.error(
                "system task cannot run in this image; it is skipped",
                extra={"task_id": spec.id, "command": spec.command, "reason": reason},
            )
            spec = SystemTaskSpec(**{**spec.__dict__, "unavailable": reason})
        checked.append(spec)
    return checked


def _unavailable(command: str) -> str | None:
    if not os.path.isfile(command):
        return f"{command} does not exist in the scheduler image"
    if not os.access(command, os.X_OK):
        return f"{command} is not executable"
    return None


def _env(task: TaskRow, run_id: str, token: str, deadline: datetime, cwd: str) -> dict[str, str]:
    """The run's whole environment: the contract, and nothing of the scheduler's own (its DB password)."""
    env = {
        "PATH": os.environ.get("PATH", "/bin"),
        "HOME": cwd,
        "LANG": "C.UTF-8",
        "SCOOTER_TASK_ID": task.id.removeprefix(SYSTEM_PREFIX),
        "SCOOTER_TASK_RUN_ID": run_id,
        "SCOOTER_TASK_RUN_TOKEN": token,
        "SCOOTER_TASK_DEADLINE": deadline.isoformat(),
        "SCOOTER_TASK_MODEL": task.model or "",
        "AGENT_HOST_URL": settings.agent_host_url,
        "BROKER_URL": settings.broker_url,
        "SCHEDULER_URL": settings.scheduler_url,
        "SCOOTER_TOKEN_PATH": settings.sa_token_path,
        "SCOOTER_BROKER_TOKEN_PATH": settings.broker_token_path,
        "LOG_LEVEL": settings.log_level,
    }
    for key in ("SSL_CERT_FILE", "TZ"):
        if key in os.environ:
            env[key] = os.environ[key]
    return {k: v for k, v in env.items() if v}


class Runner:
    """Runs due system tasks in the background, one run per task, capped overall."""

    def __init__(self, store: Store, metrics: MetricsSink, *, concurrency: int, kill_grace_seconds: float = 30.0):
        self.store = store
        self.metrics = metrics
        self.kill_grace_seconds = kill_grace_seconds
        self._slots = asyncio.Semaphore(concurrency)
        # task id -> the asyncio task running (or queued to run) it on this replica.
        self._live: dict[str, asyncio.Task] = {}

    def launch(self, task: TaskRow) -> bool:
        """Start a run of `task` in the background; False (and counted) if it is still running."""
        if task.id in self._live:
            self._skipped(task, "still running on this replica")
            return False
        job = asyncio.create_task(self._run(task), name=f"system-task:{task.id}")
        self._live[task.id] = job
        job.add_done_callback(lambda _: self._live.pop(task.id, None))
        return True

    def _skipped(self, task: TaskRow, why: str) -> None:
        self.metrics.system_run_skipped()
        logger.warning("system task skipped: its last run has not finished", extra={"task_id": task.id, "reason": why})

    async def wait_idle(self) -> None:
        """Wait for every live run (tests)."""
        while self._live:
            await asyncio.gather(*list(self._live.values()), return_exceptions=True)

    async def shutdown(self) -> None:
        """Stop every live run; each is recorded as failed and its process group killed."""
        for job in list(self._live.values()):
            job.cancel()
        await asyncio.gather(*list(self._live.values()), return_exceptions=True)

    async def _run(self, task: TaskRow) -> None:
        async with self._slots:
            token = secrets.token_urlsafe(32)
            try:
                run_id = await self.store.start_system_run(task, token)
            except Exception:
                logger.exception("could not open a run; the task waits for its next window", extra={"task_id": task.id})
                return
            if run_id is None:
                self._skipped(task, "still running on another replica")
                return
            await self._execute(task, run_id, token)

    async def _execute(self, task: TaskRow, run_id: str, token: str) -> None:
        log = {"task_id": task.id, "run_id": run_id}
        timeout = task.timeout_seconds or 600
        deadline = datetime.now(timezone.utc) + timedelta(seconds=timeout)
        cwd = os.path.join(settings.task_tmp_dir, f"task-{run_id}")
        started = time.perf_counter()
        status, exit_code, error = "failed", None, None
        proc: asyncio.subprocess.Process | None = None
        tail: collections.deque[bytes] = collections.deque()
        try:
            os.makedirs(cwd, mode=0o700, exist_ok=True)
            proc = await asyncio.create_subprocess_exec(
                task.command, *json.loads(task.args or "[]"),
                cwd=cwd, env=_env(task, run_id, token, deadline, cwd),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                # Its own process group, so the timeout reaches whatever it forked.
                start_new_session=True,
            )
            logger.info("system task started", extra={**log, "pid": proc.pid})
            pumps = asyncio.gather(
                _pump(proc.stdout, "stdout", log, None),
                _pump(proc.stderr, "stderr", log, tail),
            )
            try:
                exit_code = await asyncio.wait_for(proc.wait(), timeout)
                status = "succeeded" if exit_code == 0 else "failed"
            except asyncio.TimeoutError:
                status = "timed_out"
                exit_code = await self._stop(proc, log)
                error = f"timed out after {timeout}s"
            # A grandchild that left the group can hold the pipes open; don't wait on it forever.
            try:
                await asyncio.wait_for(pumps, 5.0)
            except asyncio.TimeoutError:
                logger.warning("system task output still open after exit; no longer reading it", extra=log)
            if status == "failed":
                error = _tail_text(tail) or f"exited {exit_code}"
        except asyncio.CancelledError:
            if proc is not None and proc.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGKILL)
            error = "the scheduler shut down during this run"
            await self._finish(run_id, log, "failed", None, error, started)
            raise
        except Exception as e:  # noqa: BLE001 — e.g. the command vanished, or exec failed
            error = f"could not run: {type(e).__name__}: {e}"
            logger.exception("system task could not run", extra=log)
        finally:
            shutil.rmtree(cwd, ignore_errors=True)
        await self._finish(run_id, log, status, exit_code, error, started)

    async def _stop(self, proc: asyncio.subprocess.Process, log: dict) -> int | None:
        """SIGTERM the group, then SIGKILL it after the grace period."""
        logger.warning("system task timed out; sending SIGTERM", extra=log)
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            return await asyncio.wait_for(proc.wait(), self.kill_grace_seconds)
        except asyncio.TimeoutError:
            logger.warning("system task ignored SIGTERM; sending SIGKILL", extra=log)
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            return await proc.wait()

    async def _finish(self, run_id, log, status, exit_code, error, started) -> None:
        duration_ms = (time.perf_counter() - started) * 1000
        self.metrics.system_run_completed(status=status, duration_ms=duration_ms)
        logger.info(
            "system task finished",
            extra={**log, "status": status, "exit_code": exit_code, "error": error, "duration_ms": duration_ms},
        )
        for attempt in (1, 2):
            try:
                await self.store.finish_system_run(run_id, status=status, exit_code=exit_code, error=error)
                return
            except Exception:  # noqa: BLE001
                if attempt == 2:
                    logger.exception("could not record the run's outcome", extra=log)
                    return
                await asyncio.sleep(1.0)


async def _pump(stream, name: str, log: dict, tail: collections.deque[bytes] | None) -> None:
    """Log every line of a stream; keep the last STDERR_TAIL_BYTES of it in `tail`."""
    kept = 0
    while True:
        try:
            line = await stream.readline()
        except ValueError:  # a line longer than the stream limit: take what is buffered
            line = await stream.read(65536)
        if not line:
            return
        logger.info(line.decode(errors="replace").rstrip("\n"), extra={**log, "stream": name})
        if tail is not None:
            tail.append(line)
            kept += len(line)
            while kept > STDERR_TAIL_BYTES and len(tail) > 1:
                kept -= len(tail.popleft())


def _tail_text(tail: collections.deque[bytes]) -> str:
    return b"".join(tail)[-STDERR_TAIL_BYTES:].decode(errors="replace").strip()
