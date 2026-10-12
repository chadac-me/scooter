"""scooter_lib: the shared, service-agnostic library for Scooter's Python services.

Logic common to every Python service and usable by contribs (the structured-logging
convention and the settings base); the two extension-surface libs build on it, and
nothing here may import a service app or either of them.
"""

from .logging_config import configure_logging, format_error, get_logger

__all__ = ["configure_logging", "format_error", "get_logger"]
