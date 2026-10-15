"""files settings, owned by this contrib.

The shared `broker` database and the caller's identity arrive through the
BrokerContext and the core auth dependency, so nothing about either is configured
here. What is left is whether the annotation store is mounted at all, and where to
wake a conversation when a human leaves a remark.
"""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class FilesSettings(ScooterBaseSettings):
    # The sandbox-side viewer ships with the image; this is the BROKER half, which a
    # deployment can leave off to run the viewer read-only with no durable comments.
    files_annotations_enabled: bool = False

    # Where to prompt the conversation when an annotation is first stored; empty
    # leaves annotations durable but silent, which the viewer renders as such.
    files_agent_host_url: str = ""
    files_notify_attempts: int = 3
    files_notify_backoff: float = 0.5


settings = FilesSettings()
