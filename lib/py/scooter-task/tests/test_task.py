"""@task: the standard flags and their env fallbacks, ctx.spawn, spawn reporting and exit codes."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import textwrap
import time

import click
import httpx
import pytest
from click.testing import CliRunner

import scooter_task
from scooter_lib.client import ScooterClient
from scooter_task import TaskContext, task


class _Fake:
    """The agent-host and scheduler a task talks to."""

    def __init__(self, prompt_status: int = 200, report_status: int = 204):
        self.prompt_status, self.report_status = prompt_status, report_status
        self.calls: list[tuple[str, dict]] = []
        self.n = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        self.calls.append((request.url.path, body))
        if request.url.path == "/conversations":
            self.n += 1
            return httpx.Response(201, json={"id": f"conv-{self.n}"})
        if request.url.path == "/agui":
            return httpx.Response(self.prompt_status)
        if request.url.path.startswith("/runs/"):
            return httpx.Response(self.report_status)
        if request.url.path == "/users":
            return httpx.Response(200, json={"users": [{"id": "alice"}, {"id": "bob"}]})
        return httpx.Response(404)

    def paths(self) -> list[str]:
        return [p for p, _ in self.calls]


@pytest.fixture
def fake(monkeypatch, tmp_path):
    f = _Fake()

    def from_env(**kw):
        return ScooterClient(
            agent_host_url="http://agent-host", scheduler_url="http://scheduler",
            token_path=str(tmp_path / "token"), run_token="rt", transport=httpx.MockTransport(f.handler), backoff_seconds=0.0,
        )

    monkeypatch.setattr(scooter_task.ScooterClient, "from_env", staticmethod(from_env))
    for var in ("SCOOTER_TASK_RUN_ID", "SCOOTER_TASK_DEADLINE", "SCOOTER_TASK_MODEL"):
        monkeypatch.delenv(var, raising=False)
    return f


seen: dict = {}


@task(name="fan-out")
@click.option("--greeting", default="hi")
async def fan_out(ctx: TaskContext, greeting: str) -> None:
    seen.update(name=ctx.name, run_id=ctx.run_id, deadline=ctx.deadline, model=ctx.model, dry_run=ctx.dry_run)
    for user in await ctx.scooter.list_users():
        await ctx.spawn(owner=user["id"], prompt=greeting, title="t")
    seen["spawned"] = list(ctx.spawned)


def invoke(cmd, args=(), env=None):
    seen.clear()
    return CliRunner().invoke(cmd, list(args), env=env)


def test_spawns_with_system_source_and_reports_each_spawn_on_the_run(fake):
    r = invoke(fan_out, ["--run-id", "run-1", "--model", "fast", "--greeting", "yo"])
    assert r.exit_code == 0, r.output
    assert fake.paths() == [
        "/users",
        "/conversations", "/agui", "/runs/run-1/conversations",
        "/conversations", "/agui", "/runs/run-1/conversations",
    ]
    prompts = [b for p, b in fake.calls if p == "/agui"]
    assert [b["owner"] for b in prompts] == ["alice", "bob"]
    assert {b["source"] for b in prompts} == {"system"}
    assert {b["model"] for b in prompts} == {"fast"}
    assert {b["messages"][0]["content"] for b in prompts} == {"yo"}
    reports = [b for p, b in fake.calls if p.startswith("/runs/")]
    assert reports == [{"conversation_id": "conv-1", "owner": "alice"}, {"conversation_id": "conv-2", "owner": "bob"}]
    assert seen["spawned"] == ["conv-1", "conv-2"]


def test_the_standard_flags_fall_back_to_the_scheduler_env(fake):
    env = {"SCOOTER_TASK_RUN_ID": "run-9", "SCOOTER_TASK_DEADLINE": "2026-10-23T12:00:00+00:00", "SCOOTER_TASK_MODEL": "m1"}
    r = invoke(fan_out, env=env)
    assert r.exit_code == 0, r.output
    assert seen["run_id"] == "run-9" and seen["model"] == "m1" and seen["name"] == "fan-out"
    assert seen["deadline"].isoformat() == "2026-10-23T12:00:00+00:00"


def test_a_hand_run_reports_nothing(fake):
    r = invoke(fan_out)
    assert r.exit_code == 0, r.output
    assert not [p for p in fake.paths() if p.startswith("/runs/")]
    # No model flag or env: the conversation runs on the deployment's default.
    assert all("model" not in b for p, b in fake.calls if p in ("/conversations", "/agui"))


def test_dry_run_spawns_nothing(fake):
    r = invoke(fan_out, ["--dry-run"])
    assert r.exit_code == 0, r.output
    assert fake.paths() == ["/users"] and seen["spawned"] == []


def test_a_bad_deadline_is_a_usage_error(fake):
    assert invoke(fan_out, ["--deadline", "soon"]).exit_code == 2


def test_an_exception_exits_1_with_a_one_line_error(fake):
    fake.prompt_status = 403
    r = invoke(fan_out)
    assert r.exit_code == 1
    assert r.output.strip().splitlines()[-1] == "fan-out: SpawnError: prompt failed: HTTP 403"


def test_a_failed_report_does_not_stop_the_fan_out(fake):
    fake.report_status = 500
    r = invoke(fan_out, ["--run-id", "run-1"])
    assert r.exit_code == 0, r.output
    assert seen["spawned"] == ["conv-1", "conv-2"]


@task(name="plain")
def plain(ctx: TaskContext) -> None:
    seen["id"] = ctx.sync(ctx.spawn(owner="alice", prompt="p"))


def test_a_plain_def_task_runs_and_can_spawn_through_sync(fake):
    r = invoke(plain)
    assert r.exit_code == 0, r.output
    assert seen["id"] == "conv-1"


def test_help_lists_the_task_and_standard_flags():
    r = CliRunner().invoke(fan_out, ["--help"])
    assert r.exit_code == 0
    for flag in ("--greeting", "--run-id", "--deadline", "--model", "--dry-run"):
        assert flag in r.output


def test_a_task_cannot_redefine_a_standard_flag():
    with pytest.raises(TypeError, match="--model is a standard flag"):
        task(name="x")(click.option("--model")(lambda ctx, model: None))


def test_sigterm_cancels_the_task_and_exits_143(tmp_path):
    script = tmp_path / "sleepy.py"
    script.write_text(textwrap.dedent("""
        import asyncio, sys
        from scooter_task import task

        @task(name="sleepy")
        async def main(ctx):
            print("ready", flush=True)
            try:
                await asyncio.sleep(60)
            finally:
                print("cleaned up", flush=True)

        main()
    """))
    env = {**os.environ, "AGENT_HOST_URL": "http://127.0.0.1:9"}
    p = subprocess.Popen([sys.executable, str(script)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True)
    assert p.stdout.readline().strip() == "ready"
    time.sleep(0.1)
    p.send_signal(signal.SIGTERM)
    out, err = p.communicate(timeout=10)
    assert p.returncode == 143
    assert "cleaned up" in out
    assert err.strip().splitlines()[-1] == "sleepy: terminated"


def test_log_lines_keep_their_own_fields_alongside_the_run(fake, caplog):
    import logging

    with caplog.at_level(logging.INFO):
        invoke(fan_out, ["--run-id", "run-3"])
    rec = next(r for r in caplog.records if r.getMessage() == "spawned")
    assert (rec.task, rec.run_id, rec.owner, rec.conversation_id) == ("fan-out", "run-3", "alice", "conv-1")
