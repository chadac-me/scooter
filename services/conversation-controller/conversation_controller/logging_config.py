"""Structured logging for the conversation-controller, matching services/agent-host/src/log.ts.

Each line is one JSON object on stdout: ts, level, service, component, a short constant msg,
and every varying value as a snake_case field passed through the stdlib `extra=` kwarg, e.g.
`logger.info("assigned", extra={"conversation_id": name, "host_pod": pod})`. The conversation
id field is always spelled `conversation_id`, since the cross-service query depends on it.
A terminal gets the pretty renderer instead (LOG_FORMAT=pretty, the default outside a container).
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

# Attributes the stdlib puts on every LogRecord, plus the few it only sets sometimes; anything
# else on a record came from the caller's `extra=`.
_STANDARD_RECORD_FIELDS = frozenset(
    vars(
        logging.LogRecord(
            name="", level=logging.INFO, pathname="", lineno=0, msg="", args=(), exc_info=None
        )
    )
) | {"asctime", "message", "taskName"}

# `component` is consumed into the envelope; the reserved fields are renamed on collision.
_CONSUMED = frozenset({"component"})
_RESERVED = frozenset({"ts", "level", "service", "msg"})

_LEVEL_NAMES = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",  # matches the TS convention
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}


def format_error(exc: BaseException | None) -> dict[str, Any]:
    """Serialize a caught exception with its type name, a non-empty message, any status/code attributes and its cause."""
    if exc is None:
        return {"message": "", "type": "NoneType"}

    message = ""
    try:
        message = str(exc)
    except Exception:  # noqa: BLE001
        message = ""
    if not message:
        # Several transport exceptions stringify to the empty string, so fall back to repr().
        try:
            message = repr(exc)
        except Exception:  # noqa: BLE001
            message = type(exc).__name__

    out: dict[str, Any] = {"message": message, "type": type(exc).__name__}

    # Keep the status/code attributes k8s and HTTP clients hang off their errors.
    for attr in ("status", "code", "reason", "errno"):
        value = getattr(exc, attr, None)
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            out[attr] = value
        else:
            out[attr] = str(value)

    cause = exc.__cause__ or exc.__context__
    if cause is not None and cause is not exc:
        out["cause"] = format_error(cause)

    return out


def _jsonable(value: Any) -> Any:
    """Best-effort coercion so one unserializable field cannot lose the whole line."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, BaseException):
        return format_error(value)
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(v) for v in value]
    try:
        return str(value)
    except Exception:  # noqa: BLE001
        return "[unserializable]"


def _merge_extras(record: logging.LogRecord, line: dict[str, Any]) -> None:
    """Fold the caller's `extra=` fields into `line`, renaming any that collide with the envelope."""
    for key, value in vars(record).items():
        if key in _STANDARD_RECORD_FIELDS or key in _CONSUMED:
            continue
        if key.startswith("_"):
            continue
        out_key = f"field_{key}" if key in _RESERVED else key
        line[out_key] = _jsonable(value)


class JsonFormatter(logging.Formatter):
    """One JSON object per line: ts, level, service, component, msg and the caller's fields."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat().replace(
                "+00:00", "Z"
            ),
            "level": _LEVEL_NAMES.get(record.levelno, record.levelname.lower()),
            "service": self.service,
            # The logger name is the fallback so a third-party library's line is still attributable.
            "component": getattr(record, "component", None) or record.name,
            "msg": record.getMessage(),
        }
        _merge_extras(record, line)

        # An explicit extra={"error": …} wins over the structured exc_info error.
        if record.exc_info and record.exc_info[1] is not None and "error" not in line:
            line["error"] = format_error(record.exc_info[1])
        if record.exc_info:
            line["stack"] = self.formatException(record.exc_info)

        try:
            return json.dumps(line, default=str)
        except (TypeError, ValueError):
            # A field defeated even default=str, so emit the envelope alone.
            return json.dumps(
                {
                    "ts": line["ts"],
                    "level": line["level"],
                    "service": line["service"],
                    "component": line["component"],
                    "msg": line["msg"],
                    "fields": "[unserializable]",
                }
            )


class PrettyFormatter(logging.Formatter):
    """Human-readable rendering for a terminal: the familiar `[component] msg k=v` shape."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {}
        _merge_extras(record, line)
        # _merge_extras consumes `component`, so it is never present in `line`.
        component = getattr(record, "component", None) or record.name
        conversation_id = line.pop("conversation_id", None)

        if record.exc_info and record.exc_info[1] is not None and "error" not in line:
            line["error"] = format_error(record.exc_info[1])

        head = f"[{component}]"
        if conversation_id:
            head += f" conv={str(conversation_id)[:8]}"
        fields = " ".join(
            f"{k}={v if isinstance(v, (str, int, float, bool)) else json.dumps(_jsonable(v), default=str)}"
            for k, v in line.items()
        )
        out = f"{record.levelname:<7} {head} {record.getMessage()}"
        if fields:
            out += f" {fields}"
        if record.exc_info:
            out += "\n" + self.formatException(record.exc_info)
        return out


def _json_output() -> bool:
    """JSON in a container (KUBERNETES_SERVICE_HOST is set in every pod), human-readable at a terminal."""
    fmt = os.environ.get("LOG_FORMAT", "").lower()
    if fmt == "json":
        return True
    if fmt == "pretty":
        return False
    return os.environ.get("KUBERNETES_SERVICE_HOST") is not None


def _level() -> int:
    raw = os.environ.get("LOG_LEVEL", "").upper()
    if raw == "WARN":
        raw = "WARNING"
    if raw in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
        return getattr(logging, raw)
    return logging.INFO


def configure_logging(service_name: str = "conversation-controller") -> None:
    """Install the structured handler on the root logger, replacing whatever is there, so third-party lines use the same formatter."""
    formatter: logging.Formatter = (
        JsonFormatter(service_name) if _json_output() else PrettyFormatter(service_name)
    )
    # Splitting streams by level would interleave a single pass's lines across two pipes.
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(_level())



# --- warn-once ---------------------------------------------------------------

_warned: set[str] = set()


def warn_once(logger: logging.Logger, key: str, msg: str, extra: dict[str, Any]) -> None:
    """Warn the first time `key` is seen and debug after, until `forget_warned` re-arms it."""
    repeat = key in _warned
    _warned.add(key)
    if repeat:
        logger.debug(msg, extra={**extra, "repeat_suppressed": True})
    else:
        logger.warning(msg, extra=extra)


def forget_warned(keep: set[str] | None = None) -> None:
    """Re-arm every key not in `keep` (or every key when called without one)."""

    if keep is None:
        _warned.clear()
        return
    _warned.intersection_update(keep)
