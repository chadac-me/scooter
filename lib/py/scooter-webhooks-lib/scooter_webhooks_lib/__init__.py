"""scooter_webhooks_lib: the webhooks extension surface.

What a webhooks handler composes (registry, store, agent_host_client, policy,
identity, resources), so a contrib can build-depend on it directly. It depends on
`scooter_lib` and `scooter_schema` and imports nothing from the webhooks app or
from `scooter_broker_lib`; each module is given its settings at startup rather
than reading the app's config.
"""

from .registry import WebhookHandler, discover_webhooks, register_webhook

__all__ = ["WebhookHandler", "discover_webhooks", "register_webhook"]
