"""Structured JSON logging for the scheduler service, matching services/agent-host/src/log.ts.

Each line is one JSON object: ts, level, service, component, a short constant msg, and
every varying value as a field passed through the stdlib `extra=` kwarg, e.g.
`get_logger("spawn").info("prompt queued", extra={"conversation_id": cid})`. A terminal
gets the pretty renderer instead (LOG_FORMAT=pretty, the default outside a container).
"""

from __future__ import annotations

import datetime as _datetime
import json
import logging
import os
from typing import Any

# Attributes the stdlib puts on every LogRecord; anything else came from the caller's `extra=`.
_RESERVED: frozenset[str] = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "module",
        "msecs",
        "message",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "taskName",
        "thread",
        "threadName",
    }
)

# The envelope keys, which a colliding `extra=` field is renamed away from.
_ENVELOPE: tuple[str, ...] = ("ts", "level", "service", "component", "msg")


def format_error(exc: BaseException) -> dict[str, Any]:
    """Serialize an exception into {message, type} plus status and code when present, with a non-empty message even for transport exceptions whose str() is empty."""
    try:
        message = str(exc)
    except Exception:
        message = ""

    if not message:
        try:
            message = repr(exc)
        except Exception:
            message = ""
    if not message:
        message = type(exc).__name__

    out: dict[str, Any] = {"message": message, "type": type(exc).__name__}

    # An httpx.HTTPStatusError carries .response.status_code; other clients hang it off the exception.
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(exc, "status", None)
    if status is not None:
        out["status"] = status

    code = getattr(exc, "code", None)
    if code is None:
        code = getattr(exc, "errno", None)
    if code is not None:
        out["code"] = code

    return out


def _safe(value: Any) -> Any:
    """Coerce a value into something json.dumps will accept, degrading to its repr."""
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, dict):
        return {str(k): _safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_safe(v) for v in value]
    try:
        return repr(value)
    except Exception:
        return "<unrepresentable>"


# Level names follow the TypeScript convention so a cross-service query on level works.
_LEVEL_NAMES = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}


class JsonFormatter(logging.Formatter):
    """One JSON object per line, where `component` is an explicit extra or the logger name with the service prefix stripped."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def _component(self, record: logging.LogRecord) -> str:
        explicit = getattr(record, "component", None)
        if isinstance(explicit, str) and explicit:
            return explicit
        name = record.name
        prefix = f"{self.service}."
        if name.startswith(prefix):
            return name[len(prefix) :]
        return name

    def _extras(self, record: logging.LogRecord) -> dict[str, Any]:
        return {
            key: value
            for key, value in record.__dict__.items()
            if key not in _RESERVED and key != "component" and not key.startswith("_")
        }

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "ts": _datetime.datetime.fromtimestamp(
                record.created, tz=_datetime.timezone.utc
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": _LEVEL_NAMES.get(record.levelno, record.levelname.lower()),
            "service": self.service,
            "component": self._component(record),
            "msg": record.getMessage(),
        }

        for key, value in self._extras(record).items():
            line[f"{key}_" if key in _ENVELOPE else key] = _safe(value)

        # The traceback is a field, keeping the one-object-per-line contract.
        if record.exc_info:
            exc = record.exc_info[1]
            if isinstance(exc, BaseException) and "error" not in line:
                line["error"] = _safe(format_error(exc))
            line["stack"] = self.formatException(record.exc_info)
        if record.stack_info:
            line["stack_info"] = self.formatStack(record.stack_info)

        try:
            return json.dumps(line, default=repr)
        except Exception:
            # A field defeated even _safe(), so emit the envelope alone.
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
    """The `[component] msg key=value` shape, for a human at a terminal."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service
        self._json = JsonFormatter(service)

    def format(self, record: logging.LogRecord) -> str:
        component = self._json._component(record)
        extras = self._json._extras(record)
        rendered = " ".join(
            f"{key}={value if isinstance(value, str) else json.dumps(_safe(value), default=repr)}"
            for key, value in extras.items()
        )
        line = f"[{component}] {record.getMessage()}"
        if rendered:
            line = f"{line} {rendered}"
        if record.exc_info:
            line = f"{line}\n{self.formatException(record.exc_info)}"
        return line


def _json_output() -> bool:
    """JSON in a container (KUBERNETES_SERVICE_HOST is set in every pod), human-readable at a terminal."""
    fmt = os.environ.get("LOG_FORMAT", "").lower()
    if fmt == "json":
        return True
    if fmt == "pretty":
        return False
    return os.environ.get("KUBERNETES_SERVICE_HOST") is not None


def _level(default: str) -> int:
    raw = (os.environ.get("LOG_LEVEL") or default).upper()
    return logging.getLevelNamesMapping().get(raw, logging.INFO)


def configure_logging(service_name: str, *, default_level: str = "INFO") -> None:
    """Install the structured handler on the root logger, idempotently, so third-party lines share the format."""
    formatter: logging.Formatter = (
        JsonFormatter(service_name) if _json_output() else PrettyFormatter(service_name)
    )

    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    handler.set_name("scooter-structured")

    root = logging.getLogger()
    for existing in list(root.handlers):
        # A pytest caplog handler is left alone so test capture keeps working.
        if existing.get_name() == "scooter-structured" or type(existing) is logging.StreamHandler:
            root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(_level(default_level))


def get_logger(component: str, *, service: str = "scheduler") -> logging.Logger:
    """A logger whose name encodes the component, which the formatter renders as component="<name>"."""
    return logging.getLogger(f"{service}.{component}")
