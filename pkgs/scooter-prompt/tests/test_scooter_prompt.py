"""scooter-prompt against a fake agent-host: --owner, --per-user, the prompt sources, partial failure."""

from __future__ import annotations

import json

import httpx
import pytest
from click.testing import CliRunner

import scooter_task
from scooter_lib.client import ScooterClient
from scooter_prompt import main


class _Fake:
    def __init__(self, refuse: str | None = None):
        self.refuse = refuse
        self.prompts: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        if request.url.path == "/users":
            return httpx.Response(200, json={"users": [{"id": "alice"}, {"id": "bob"}, {"id": ""}]})
        if request.url.path == "/conversations":
            if body.get("owner") == self.refuse:
                return httpx.Response(403)
            return httpx.Response(201, json={"id": f"conv-{body['owner']}"})
        if request.url.path == "/agui":
            self.prompts.append(body)
            return httpx.Response(200)
        return httpx.Response(204)


@pytest.fixture
def fake(monkeypatch, tmp_path):
    f = _Fake()
    monkeypatch.setattr(
        scooter_task.ScooterClient, "from_env",
        staticmethod(lambda **kw: ScooterClient(
            agent_host_url="http://ah", token_path=str(tmp_path / "t"),
            transport=httpx.MockTransport(f.handler), backoff_seconds=0.0,
        )),
    )
    return f


def run(*args):
    return CliRunner().invoke(main, list(args))


def test_owner_spawns_for_each_named_user(fake):
    r = run("--owner", "alice", "--owner", "carol", "--prompt", "hi", "--title", "T")
    assert r.exit_code == 0, r.output
    assert [p["owner"] for p in fake.prompts] == ["alice", "carol"]
    assert {p["source"] for p in fake.prompts} == {"system"}


def test_per_user_spawns_for_every_known_user(fake, tmp_path):
    f = tmp_path / "p.md"
    f.write_text("from a file")
    r = run("--per-user", "--prompt-file", str(f))
    assert r.exit_code == 0, r.output
    assert [p["owner"] for p in fake.prompts] == ["alice", "bob"]
    assert fake.prompts[0]["messages"][0]["content"] == "from a file"


def test_one_refused_user_fails_the_run_but_not_the_others(fake):
    fake.refuse = "alice"
    r = run("--per-user", "--prompt", "hi")
    assert r.exit_code == 1
    assert [p["owner"] for p in fake.prompts] == ["bob"]
    assert r.output.strip().splitlines()[-1] == "scooter-prompt: RuntimeError: 1 of 2 spawns failed"


@pytest.mark.parametrize("args", [
    ["--owner", "a"],                                   # no prompt
    ["--owner", "a", "--prompt", "x", "--prompt-file", __file__],
    ["--prompt", "x"],                                  # no target
    ["--owner", "a", "--per-user", "--prompt", "x"],
])
def test_usage_errors(fake, args):
    r = run(*args)
    assert r.exit_code != 0 and not fake.prompts
