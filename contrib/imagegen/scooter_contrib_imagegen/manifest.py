"""What a backend is: a manifest of the models it offers (each with a JSON Schema
for its `params`), and `generate(request) -> [bytes]`. A backend is registered
through the `scooter_imagegen.backends` entry-point group (pyproject.toml), the
same discovery shape the broker's own provider registry uses, so an out-of-tree
package can add one without touching this contrib.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

# The schema a model takes no params under: an empty object, nothing else allowed.
NO_PARAMS: dict[str, Any] = {"type": "object", "additionalProperties": False, "properties": {}}


@dataclass(frozen=True)
class ModelManifest:
    """One model a backend offers."""

    name: str
    params_schema: dict[str, Any] = field(default_factory=lambda: dict(NO_PARAMS))
    description: str = ""


@dataclass(frozen=True)
class BackendManifest:
    """What a backend publishes about itself: the models it offers, in preference order."""

    models: tuple[ModelManifest, ...]

    def model(self, name: str) -> ModelManifest | None:
        return next((m for m in self.models if m.name == name), None)

    @property
    def default_model(self) -> ModelManifest:
        return self.models[0]


@dataclass(frozen=True)
class GenerateRequest:
    """What the tool asks a backend to do."""

    prompt: str
    model: str
    params: dict[str, Any]
    n: int = 1
    # Bytes of an existing image to edit/vary, or None for a fresh generation.
    reference_image: bytes | None = None


@runtime_checkable
class Backend(Protocol):
    """A generator, keyed by its entry-point name (also `provider`/`backend` the agent sees)."""

    name: str
    manifest: BackendManifest

    async def generate(self, request: GenerateRequest) -> list[bytes]: ...
