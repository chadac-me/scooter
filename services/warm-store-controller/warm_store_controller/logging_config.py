"""Structured logging for the warm-store controller, matching services/agent-host/src/log.ts.

Each line is one JSON object on stdout: ts, level, service, component, a short constant msg,
and every varying value as a field passed through the stdlib `extra=` kwarg, e.g.
`logger.info("prompt queued", extra={"conversation_id": cid})`. A terminal gets the pretty
renderer instead (LOG_FORMAT=pretty, the default outside a container).
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

# The envelope keys the formatter owns, which an `extra=` field must not clobber.
_RESERVED = ("ts", "level", "service", "component", "msg")

# Level names follow the TypeScript convention so a cross-service query on level works.
_LEVEL_NAMES = {"warning": "warn", "critical": "error", "fatal": "error"}

# Attributes present on every LogRecord; anything else non-private came from the caller's `extra=`.
_STANDARD_RECORD_ATTRS = frozenset(
    {
        "args", "asctime", "created", "exc_info", "exc_text", "filename", "funcName",
        "levelname", "levelno", "lineno", "module", "msecs", "message", "msg", "name",
        "pathname", "process", "processName", "relativeCreated", "stack_info",
        "stacklevel", "thread", "threadName", "taskName",
    }
)


def format_error(exc: BaseException) -> dict[str, Any]:
    """Serialize a caught exception with its type name, a non-empty message (falling back to repr) and any status, code or reason attributes."""
    message = ""
    try:
        message = str(exc)
    except Exception:  # noqa: BLE001
        message = ""
    if not message:
        try:
            message = repr(exc)
        except Exception:  # noqa: BLE001
            message = ""
    if not message:
        message = type(exc).__name__

    out: dict[str, Any] = {"message": message, "type": type(exc).__name__}

    for attr, key in (("status", "status"), ("code", "code"), ("errno", "code")):
        if key in out:
            continue
        value = getattr(exc, attr, None)
        if value is not None:
            out[key] = value

    reason = getattr(exc, "reason", None)
    if reason is not None:
        out["reason"] = reason

    return out


def _jsonable(value: Any) -> Any:
    """Best-effort coercion so one unserializable field cannot drop the whole line."""
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        try:
            return repr(value)
        except Exception:  # noqa: BLE001
            return "[unserializable]"


class JsonFormatter(logging.Formatter):
    """One JSON object per line: the envelope, then the record's `extra=` fields."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:  # noqa: A003
        line: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": _LEVEL_NAMES.get(record.levelname.lower(), record.levelname.lower()),
            "service": self.service,
            # The logger name is the default component; an explicit extra={"component": …} wins.
            "component": record.name.rsplit(".", 1)[-1],
            "msg": record.getMessage(),
        }

        for key, value in record.__dict__.items():
            if key in _STANDARD_RECORD_ATTRS or key.startswith("_"):
                continue
            if key in _RESERVED and key != "component":
                # A caller's field that collides with the envelope is renamed rather than dropped.
                line[f"field_{key}"] = _jsonable(value)
                continue
            line[key] = _jsonable(value)

        if record.exc_info and record.exc_info[1] is not None and "error" not in line:
            line["error"] = format_error(record.exc_info[1])
            line["error"]["stack"] = self.formatException(record.exc_info)
        elif record.exc_info:
            line["stack"] = self.formatException(record.exc_info)

        try:
            return json.dumps(line, default=repr)
        except (TypeError, ValueError):
            # A field defeated even _jsonable, so emit the envelope alone.
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
    """The `[component] message key=value` shape, for a human at a terminal."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: A003
        component = getattr(record, "component", None) or record.name.rsplit(".", 1)[-1]
        fields = {
            key: value
            for key, value in record.__dict__.items()
            if key not in _STANDARD_RECORD_ATTRS
            and not key.startswith("_")
            and key not in _RESERVED
        }
        extra = " ".join(f"{k}={v}" for k, v in fields.items())
        head = f"[{component}] {record.getMessage()}"
        line = f"{head} {extra}" if extra else head
        if record.exc_info:
            line = f"{line}\n{self.formatException(record.exc_info)}"
        return line


def _use_json() -> bool:
    """JSON in a container (KUBERNETES_SERVICE_HOST is set in every pod), human-readable at a terminal."""
    fmt = os.environ.get("LOG_FORMAT", "").lower()
    if fmt == "json":
        return True
    if fmt == "pretty":
        return False
    return os.environ.get("KUBERNETES_SERVICE_HOST") is not None


def configure_logging(service_name: str) -> None:
    """Install the structured handler on the root logger, replacing any existing handlers."""
    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, None)
    if not isinstance(level, int):
        level = logging.INFO

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service_name) if _use_json() else PrettyFormatter())

    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)
