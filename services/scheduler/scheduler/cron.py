"""Cron scheduling: the pure next-fire-time computation over a 5-field cron and an IANA timezone, via croniter."""

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter


class InvalidSchedule(ValueError):
    """A cron expression or timezone that cannot be parsed, which the API maps to 422."""


def validate(cron: str, timezone: str) -> None:
    """Raise InvalidSchedule if `cron` is not a valid 5-field cron or `timezone` is not a known IANA zone."""
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise InvalidSchedule(f"unknown timezone {timezone!r}") from e
    if not croniter.is_valid(cron):
        raise InvalidSchedule(f"invalid cron expression {cron!r}")


def next_run(cron: str, timezone: str, after: datetime) -> datetime:
    """The next fire time strictly after `after` (naive means UTC), evaluated in the task's local `timezone` and returned as an aware UTC datetime."""
    validate(cron, timezone)
    tz = ZoneInfo(timezone)
    base = _to_aware_utc(after).astimezone(tz)
    it = croniter(cron, base)
    return it.get_next(datetime).astimezone(ZoneInfo("UTC"))


def _to_aware_utc(dt: datetime) -> datetime:
    """A naive datetime is treated as UTC; an aware one is converted to UTC."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=ZoneInfo("UTC"))
    return dt.astimezone(ZoneInfo("UTC"))
