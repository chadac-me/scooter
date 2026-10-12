"""scooter-contrib-echo: the reference Scooter contrib module.

A contrib plugs into the broker through the ``agent_broker.providers`` entry point
and into webhooks through ``scooter_webhooks.handlers``, without editing either
service's core. This top-level module imports neither service so the package
import-checks standalone.
"""

from __future__ import annotations

CONTRIB_NAME = "echo"
