"""The built-in "priority" selector: ordering, and dropping backends over a cap."""

from __future__ import annotations

from scooter_contrib_imagegen.manifest import GenerateRequest
from scooter_contrib_imagegen.selectors import BackendCandidate, Usage, priority

REQUEST = GenerateRequest(prompt="a cat", model="", params={})


def test_orders_by_priority_highest_first():
    candidates = [
        BackendCandidate(name="low", priority=10, daily_limit=None),
        BackendCandidate(name="high", priority=200, daily_limit=None),
        BackendCandidate(name="mid", priority=100, daily_limit=None),
    ]
    usage = Usage(total=0, total_limit=50)
    ordered = priority(REQUEST, candidates, usage)
    assert [c.name for c in ordered] == ["high", "mid", "low"]


def test_ties_keep_declaration_order():
    candidates = [
        BackendCandidate(name="first", priority=100, daily_limit=None),
        BackendCandidate(name="second", priority=100, daily_limit=None),
    ]
    usage = Usage(total=0, total_limit=50)
    ordered = priority(REQUEST, candidates, usage)
    assert [c.name for c in ordered] == ["first", "second"]


def test_drops_a_backend_over_its_own_daily_limit():
    candidates = [
        BackendCandidate(name="capped", priority=200, daily_limit=5),
        BackendCandidate(name="uncapped", priority=10, daily_limit=None),
    ]
    usage = Usage(total=5, total_limit=50, per_backend={"capped": 5})
    ordered = priority(REQUEST, candidates, usage)
    assert [c.name for c in ordered] == ["uncapped"]


def test_drops_every_backend_once_the_user_hits_the_total_cap():
    candidates = [
        BackendCandidate(name="a", priority=200, daily_limit=None),
        BackendCandidate(name="b", priority=10, daily_limit=None),
    ]
    usage = Usage(total=50, total_limit=50)
    assert priority(REQUEST, candidates, usage) == []


def test_a_backend_under_both_caps_stays_a_candidate():
    candidates = [BackendCandidate(name="a", priority=100, daily_limit=10)]
    usage = Usage(total=3, total_limit=50, per_backend={"a": 3})
    assert [c.name for c in priority(REQUEST, candidates, usage)] == ["a"]
