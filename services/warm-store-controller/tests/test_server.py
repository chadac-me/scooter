"""The HTTP face: auth, leader-only readiness and the /reserve contract."""

import json
import threading
import urllib.error
import urllib.request

import pytest

from warm_store_controller.reserve import Result
from warm_store_controller.server import TokenAuth, make_server

AGENT_HOST = "system:serviceaccount:ns:agent-host"


@pytest.fixture
def served():
    leader = threading.Event()
    leader.set()
    reviews: list[str] = []

    def review(token, audience):
        reviews.append(token)
        return {"good": AGENT_HOST, "other": "system:serviceaccount:ns:intruder"}.get(token)

    calls: list[tuple] = []

    def reserve(sandbox, tag):
        calls.append((sandbox, tag))
        return Result("pv1", "warm", "warm")

    srv = make_server(0, leader.is_set, TokenAuth(review, "warm-store", {AGENT_HOST}), reserve)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", leader, calls, reviews
    srv.shutdown()


def call(base, path, token=None, body=None):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_reserve_returns_the_pv(served):
    base, _, calls, _ = served
    assert call(base, "/reserve", "good", {"sandbox": "conv-a", "tag": "t"}) == (
        200, {"pv": "pv1", "pool": "warm", "reason": "warm"}
    )
    assert calls == [("conv-a", "t")]


def test_reserve_rejects_other_callers(served):
    base, _, calls, _ = served
    assert call(base, "/reserve", None, {"sandbox": "conv-a"})[0] == 401
    assert call(base, "/reserve", "other", {"sandbox": "conv-a"})[0] == 401
    assert calls == []


def test_successful_reviews_are_cached(served):
    base, _, _, reviews = served
    call(base, "/reserve", "good", {"sandbox": "conv-a"})
    call(base, "/reserve", "good", {"sandbox": "conv-b"})
    assert reviews == ["good"]


def test_only_the_leader_is_ready_or_reserves(served):
    base, leader, _, _ = served
    assert call(base, "/readyz")[0] == 200
    leader.clear()
    assert call(base, "/readyz")[0] == 503
    assert call(base, "/healthz")[0] == 200
    assert call(base, "/reserve", "good", {"sandbox": "conv-a"})[0] == 503


def test_a_bad_body_is_400(served):
    base, _, _, _ = served
    assert call(base, "/reserve", "good", {"tag": "t"})[0] == 400
