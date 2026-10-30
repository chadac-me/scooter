"""Canonical shapes for (source, resource_type, resource_id), the one place that knows ("pull_request", "o/r#7") and ("pr", "<html_url>") are the same resource.

What is written to resource_links is normalised and every known shape is matched on
read; conversation_map is never rewritten, since its resource_id is matched exactly
to route a webhook. Each provider registers its own shapes, and a provider with
none degrades to exact match.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from importlib.resources import files

# (resource_type, resource_id) -> every id form naming that resource, the caller's first.
IdVariants = Callable[[str, str], list[str]]


@dataclass(frozen=True)
class ResourceShapes:
    """One provider's resource-identity knowledge: ``type_aliases`` maps every spelling to the canonical long form, and ``id_variants`` is optional."""

    type_aliases: dict[str, str] = field(default_factory=dict)
    id_variants: IdVariants | None = None


_shapes: dict[str, ResourceShapes] = {}


def load_type_aliases(package: str) -> dict[str, str]:
    """A contrib's ``link_type_aliases.json``, the table its contrib.nix also hands the agent-host."""
    return json.loads((files(package) / "link_type_aliases.json").read_text())


def register_resource_shapes(source: str, shapes: ResourceShapes) -> None:
    """Register one provider's shapes, replacing any earlier registration."""
    _shapes[source] = shapes


def registered_sources() -> list[str]:
    """Which sources contribute shapes, for diagnostics."""
    return sorted(_shapes)


def canonical_resource_type(source: str, resource_type: str) -> str:
    """The long-form type for this source; unknown types pass through unchanged."""
    shapes = _shapes.get(source)
    if shapes is None:
        return resource_type
    return shapes.type_aliases.get(resource_type.lower(), resource_type)


def _type_variants(source: str, resource_type: str) -> list[str]:
    """Every spelling of this type, the caller's own first."""
    shapes = _shapes.get(source)
    if shapes is None:
        return [resource_type]
    canonical = canonical_resource_type(source, resource_type)
    others = [
        alias
        for alias, target in shapes.type_aliases.items()
        if target == canonical and alias != resource_type
    ]
    return [resource_type, *others]


def resource_id_variants(source: str, resource_type: str, resource_id: str) -> list[str]:
    """Every id form that names this resource, the caller's own first; an unparseable id yields only itself."""
    shapes = _shapes.get(source)
    if shapes is None or shapes.id_variants is None:
        return [resource_id]
    return shapes.id_variants(resource_type, resource_id)


def link_variants(source: str, resource_type: str, resource_id: str) -> list[tuple[str, str]]:
    """(resource_type, resource_id) pairs to try, the caller's own shape first."""
    out: list[tuple[str, str]] = []
    for rid in resource_id_variants(source, resource_type, resource_id):
        for rtype in _type_variants(source, resource_type):
            pair = (rtype, rid)
            if pair not in out:
                out.append(pair)
    return out


def canonical_link(source: str, resource_type: str, resource_id: str) -> tuple[str, str]:
    """The shape to store in resource_links: the long-form type, and the URL form when one is derivable."""
    rtype = canonical_resource_type(source, resource_type)
    rid = resource_id
    for candidate in resource_id_variants(source, rtype, resource_id):
        if candidate.startswith("http://") or candidate.startswith("https://"):
            rid = candidate
            break
    return rtype, rid
