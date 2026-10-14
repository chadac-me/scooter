"""Tier 1: the pure cron next-fire computation."""

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from scheduler.cron import next_run, validate, InvalidSchedule


def test_next_run_daily_utc():
    after = datetime(2026, 7, 24, 8, 0, tzinfo=ZoneInfo("UTC"))
    nxt = next_run("0 9 * * *", "UTC", after)
    assert nxt == datetime(2026, 7, 24, 9, 0, tzinfo=ZoneInfo("UTC"))


def test_next_run_is_strictly_after():
    # Exactly at the fire time yields the next occurrence, never `after` itself.
    after = datetime(2026, 7, 24, 9, 0, tzinfo=ZoneInfo("UTC"))
    nxt = next_run("0 9 * * *", "UTC", after)
    assert nxt == datetime(2026, 7, 25, 9, 0, tzinfo=ZoneInfo("UTC"))


def test_next_run_respects_timezone():
    after = datetime(2026, 7, 24, 8, 0, tzinfo=ZoneInfo("UTC"))
    nxt = next_run("0 9 * * *", "America/New_York", after)
    assert nxt == datetime(2026, 7, 24, 13, 0, tzinfo=ZoneInfo("UTC"))


def test_next_run_weekday_only():
    sat = datetime(2026, 7, 25, 10, 0, tzinfo=ZoneInfo("UTC"))  # a Saturday
    nxt = next_run("0 9 * * 1-5", "UTC", sat)
    assert nxt == datetime(2026, 7, 27, 9, 0, tzinfo=ZoneInfo("UTC"))  # the following Monday


def test_next_run_accepts_naive_after_as_utc():
    naive = datetime(2026, 7, 24, 8, 0)
    nxt = next_run("0 9 * * *", "UTC", naive)
    assert nxt == datetime(2026, 7, 24, 9, 0, tzinfo=ZoneInfo("UTC"))
    assert nxt.tzinfo is not None


def test_validate_rejects_bad_cron():
    with pytest.raises(InvalidSchedule):
        validate("not a cron", "UTC")


def test_validate_rejects_bad_timezone():
    with pytest.raises(InvalidSchedule):
        validate("0 9 * * *", "Mars/Olympus_Mons")


def test_validate_accepts_good():
    validate("*/15 * * * *", "America/Los_Angeles")
