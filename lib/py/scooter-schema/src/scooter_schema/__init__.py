"""scooter_schema: generated SQLAlchemy models for Scooter's shared databases.

One module per database, generated from lib/sql/<db>/schema.sql by
``just db-generate`` and never hand-edited; ``guard`` is not generated. Import
only the database you own and assert it with ``guard.assert_database``.
"""

from . import broker, byoc, scheduler, webhooks
from .guard import assert_database, assert_database_sync, check_database

__all__ = [
    "webhooks",
    "scheduler",
    "broker",
    "byoc",
    "assert_database",
    "assert_database_sync",
    "check_database",
]
