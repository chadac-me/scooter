"""Structured logging for every Scooter Python service.

One JSON object per line on stdout (`ts`, `level`, `service`, `component`, `msg`
plus the caller's `extra=` fields), mirroring services/agent-host/src/log.ts field
for field so a Loki query written for one service works against the other. `msg`
is a short constant string and the variable values go in `extra=`, which is what
makes lines groupable. A human at a terminal gets the pretty renderer instead
(LOG_FORMAT=pretty, the default outside a container).
"""

from __future__ import annotations

import json
import hashlib
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

# Tag on our handler so a re-configure replaces exactly this one and leaves the host application's handlers alone.
HANDLER_NAME = "scooter-structured"

# Attributes the stdlib puts on every LogRecord, built by construction so a new stdlib attribute never leaks into the JSON.
_STANDARD_ATTRS = frozenset(
    vars(
        logging.LogRecord(
            name="", level=0, pathname="", lineno=0, msg="", args=(), exc_info=None
        )
    )
) | {
    # Set by Logger.makeRecord after __init__, so not visible above.
    "message",
    "asctime",
    "taskName",
}

# The envelope keys, which a caller's `extra=` is never allowed to overwrite.
_RESERVED = ("ts", "level", "service", "component", "msg")

# Level values match agent-host's Level union so a cross-service query on level works.
_LEVEL_NAMES = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}

# Cyclic or deeply nested data costs a truncated field, never the line.
_MAX_DEPTH = 8


def format_error(exc: BaseException | None, _depth: int = 0) -> dict[str, Any]:
    """Serialize a caught exception into a dict that always has a message, plus the status/code fields HTTP, AWS and k8s clients hang off it."""
    if exc is None:
        return {}

    message = ""
    try:
        message = str(exc)
    except Exception:  # a broken __str__ must not take the log line with it
        message = ""
    if not message:
        # Several httpx transport exceptions carry an empty message, so fall back to repr() and then the type name.
        try:
            message = repr(exc)
        except Exception:
            message = ""
    if not message:
        message = type(exc).__name__

    out: dict[str, Any] = {"message": message, "type": type(exc).__name__}

    # Map whatever the client library named it onto the two conventional keys.
    for attr, key in (
        ("status", "status"),
        ("status_code", "status"),
        ("code", "code"),
        ("errno", "code"),
    ):
        if key in out:
            continue
        value = getattr(exc, attr, None)
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            out[key] = value

    response = getattr(exc, "response", None)

    # httpx.HTTPStatusError hangs the Response off the exception rather than carrying a status itself.
    if "status" not in out:
        status = getattr(response, "status_code", None)
        if isinstance(status, int):
            out["status"] = status

    # botocore ClientError: the useful code is buried in response["Error"]["Code"].
    if isinstance(response, dict):
        if "code" not in out:
            error = response.get("Error")
            if isinstance(error, dict):
                error_code = error.get("Code")
                if isinstance(error_code, (str, int)):
                    out["code"] = error_code
        if "status" not in out:
            metadata = response.get("ResponseMetadata")
            if isinstance(metadata, dict):
                status_code = metadata.get("HTTPStatusCode")
                if isinstance(status_code, int):
                    out["status"] = status_code

    cause = exc.__cause__
    if cause is not None and cause is not exc and _depth < _MAX_DEPTH:
        out["cause"] = format_error(cause, _depth + 1)

    return out


def _coerce(value: Any, _depth: int = 0) -> Any:
    """Make one field value JSON-safe without ever raising."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if _depth >= _MAX_DEPTH:
        try:
            return repr(value)
        except Exception:
            return f"<unserializable {type(value).__name__}>"
    if isinstance(value, (list, tuple, set)):
        return [_coerce(v, _depth + 1) for v in value]
    if isinstance(value, dict):
        return {str(k): _coerce(v, _depth + 1) for k, v in value.items()}
    if isinstance(value, BaseException):
        return format_error(value)
    if isinstance(value, datetime):
        return value.isoformat()
    try:
        return str(value)
    except Exception:
        return f"<unserializable {type(value).__name__}>"


def _extras(record: logging.LogRecord) -> dict[str, Any]:
    """The caller's `extra=` fields, and nothing else."""
    return {
        key: value
        for key, value in vars(record).items()
        if key not in _STANDARD_ATTRS and not key.startswith("_")
    }


def _component(record: logging.LogRecord, prefix: str | None) -> str:
    """An explicit `extra={"component": ...}`, else the logger name with the service's package prefix stripped."""
    explicit = getattr(record, "component", None)
    if isinstance(explicit, str) and explicit:
        return explicit
    name = record.name
    if prefix and name.startswith(prefix):
        return name[len(prefix) :]
    return name


def _prefix_for(service: str | None) -> str | None:
    """The package prefix a service's loggers are named under (`broker` -> `broker.`)."""
    return f"{service}." if service else None


class JsonFormatter(logging.Formatter):
    """One JSON object per line: ts, level, service, component, msg + extras."""

    def __init__(self, service: str, component_prefix: str | None = None) -> None:
        super().__init__()
        self.service = service
        self.component_prefix = (
            component_prefix if component_prefix is not None else _prefix_for(service)
        )

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": _LEVEL_NAMES.get(record.levelno, record.levelname.lower()),
            "service": self.service,
            "component": _component(record, self.component_prefix),
            "msg": record.getMessage(),
        }

        for key, value in _extras(record).items():
            # An extra that collides with the envelope is renamed, never dropped.
            if key in _RESERVED:
                key = f"field_{key}"
            line[key] = _coerce(value)

        # exc_info goes in as a structured field, not a text blob after the JSON.
        if record.exc_info and record.exc_info[1] is not None:
            error = line.get("error")
            if not isinstance(error, dict):
                error = format_error(record.exc_info[1])
                line["error"] = error
            error.setdefault("stack", self.formatException(record.exc_info))

        # stack_info is the call site, a different question from the traceback in `error.stack`.
        if record.stack_info:
            line["stack"] = self.formatStack(record.stack_info)

        try:
            return json.dumps(line, default=str)
        except Exception:
            # Emit the envelope rather than lose the event entirely.
            return json.dumps(
                {key: line.get(key) for key in _RESERVED}
                | {"fields": "[unserializable]"},
                default=str,
            )


class PrettyFormatter(logging.Formatter):
    """`[component] msg key=value`, for a human at a terminal."""

    def __init__(self, service: str | None = None, component_prefix: str | None = None) -> None:
        super().__init__()
        self.service = service
        self.component_prefix = (
            component_prefix if component_prefix is not None else _prefix_for(service)
        )

    def format(self, record: logging.LogRecord) -> str:
        fields = " ".join(
            f"{key}={_render(_coerce(value))}"
            for key, value in sorted(_extras(record).items())
        )
        level = _LEVEL_NAMES.get(record.levelno, record.levelname.lower())
        head = f"{level:<5} [{_component(record, self.component_prefix)}] {record.getMessage()}"
        text = f"{head} {fields}" if fields else head
        if record.exc_info:
            text = f"{text}\n{self.formatException(record.exc_info)}"
        return text


def _render(value: Any) -> str:
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str)
    return str(value)


def use_json() -> bool:
    """JSON in a container (KUBERNETES_SERVICE_HOST is set in every pod), human-readable at a terminal."""
    fmt = os.environ.get("LOG_FORMAT", "").strip().lower()
    if fmt == "json":
        return True
    if fmt == "pretty":
        return False
    return os.environ.get("KUBERNETES_SERVICE_HOST") is not None


def configure_logging(
    service_name: str,
    level: str | None = None,
    *,
    component_prefix: str | None = None,
) -> None:
    """Install the structured formatter on the root logger, idempotently, leaving the host application's handlers alone."""
    raw = (level or os.environ.get("LOG_LEVEL") or "INFO").strip().upper()
    resolved = logging.getLevelNamesMapping().get(raw, logging.INFO)

    formatter: logging.Formatter = (
        JsonFormatter(service_name, component_prefix)
        if use_json()
        else PrettyFormatter(service_name, component_prefix)
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    handler.set_name(HANDLER_NAME)

    root = logging.getLogger()
    for existing in list(root.handlers):
        # Remove ours and a bare basicConfig StreamHandler; `type(...) is` keeps subclasses like pytest's LogCaptureHandler.
        if existing.get_name() == HANDLER_NAME or type(existing) is logging.StreamHandler:
            root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(resolved)


def get_logger(service: str, component: str) -> logging.Logger:
    """A logger named `<service>.<component>`, which the formatter renders as component="<component>"."""
    return logging.getLogger(f"{service}.{component}")


def pseudonym(value: str | None) -> str | None:
    """A stable, non-reversible stand-in for a personal identifier, so logs can correlate a principal without naming it."""
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]
