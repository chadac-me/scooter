"""files settings, owned by this contrib.

The shared `broker` database and the caller's identity arrive through the
BrokerContext and the core auth dependency, so nothing about either is configured
here. What is left is whether the annotation store is mounted at all. Waking the
conversation is the sandbox viewer's job, not the broker's.
"""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class FilesSettings(ScooterBaseSettings):
    # The sandbox-side viewer ships with the image; this is the BROKER half, which a
    # deployment can leave off to run the viewer read-only with no durable comments.
    files_annotations_enabled: bool = False


settings = FilesSettings()
