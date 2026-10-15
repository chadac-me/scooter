"""Question fields authored in a document's markdown.

A question is an HTML comment block, so the document stays valid markdown that renders
anywhere — GitHub included — and the file remains the author's source of truth. The
viewer only finds them; answers are stored as annotations and the agent is what writes
a decision back into the prose.

Scanning is deliberately line-based rather than a markdown parse: the viewer ships in
the sandbox image, where the pinned browser renderer is the only markdown implementation
and it runs in the page, not here.
"""

from __future__ import annotations

import re

KINDS = ("single", "multi", "text")

MARKDOWN_SUFFIXES = (".md", ".markdown")

_OPEN = re.compile(r"^\s*<!--\s*scooter:question\s+(?P<attrs>[^>]*?)\s*-->\s*$")
_CLOSE = re.compile(r"^\s*<!--\s*/scooter:question\s*-->\s*$")
_ATTR = re.compile(r"(\w+)\s*=\s*(\"[^\"]*\"|'[^']*'|\S+)")
# A task-list item, with the checkbox optional so a plain option list still reads as
# options rather than as prose.
_OPTION = re.compile(r"^\s*[-*]\s+(?:\[(?P<mark>[ xX])\]\s+)?(?P<label>.+?)\s*$")
# An opening or closing fence, tildes included; the info string is ignored.
_FENCE = re.compile(r"^(?P<indent>\s*)(?P<fence>```+|~~~+)\s*(?P<info>\S*).*$")
# Four spaces or a tab is an indented code block, where nothing is syntax.
_INDENTED = re.compile(r"^(?: {4}|\t)")


def parse_if_markdown(content: str, path: str) -> list[dict]:
    """Fields in `content`, or nothing when the path is not a markdown document."""
    if not path.lower().endswith(MARKDOWN_SUFFIXES):
        return []
    return parse(content)


def parse(content: str) -> list[dict]:
    """Every live question field in a document, in the order it appears.

    A block inside a code fence is an example of the syntax rather than a field: the
    design calls this out because the prototype renderer for that very document found
    five questions in a four-question doc.
    """
    fields: list[dict] = []
    seen: set[str] = set()
    fence: str | None = None
    open_at: int | None = None
    attrs: dict[str, str] = {}
    body: list[str] = []

    for number, line in enumerate(content.splitlines(), start=1):
        match = _FENCE.match(line)
        if match and (fence is None or match.group("fence")[0] == fence[0]):
            # A fence closes only on the same character, so ``` inside a ~~~ block is
            # content.
            fence = None if fence is not None else match.group("fence")
            continue
        if fence is not None or _INDENTED.match(line):
            continue

        if open_at is None:
            opened = _OPEN.match(line)
            if opened:
                attrs = _attrs(opened.group("attrs"))
                open_at, body = number, []
            continue

        if _CLOSE.match(line):
            field = _field(attrs, body, open_at)
            if field is not None and field["id"] not in seen:
                seen.add(field["id"])
                fields.append(field)
            open_at = None
            continue

        reopened = _OPEN.match(line)
        if reopened:
            # The previous block was never closed, so it is malformed and dropped; the
            # one starting here is still worth reading.
            attrs = _attrs(reopened.group("attrs"))
            open_at, body = number, []
            continue

        body.append(line)

    return fields


def _attrs(raw: str) -> dict[str, str]:
    return {k: v.strip("\"'") for k, v in _ATTR.findall(raw)}


def _field(attrs: dict[str, str], body: list[str], line: int) -> dict | None:
    """One field, or None when the block cannot be answered as written."""
    question_id = attrs.get("id", "").strip()
    if not question_id:
        # The id is how an answer finds its question, so a block without one has
        # nowhere to store a reply.
        return None
    kind = attrs.get("kind", "single").strip() or "single"
    if kind not in KINDS:
        return None

    options = []
    prompt: list[str] = []
    for text in body:
        option = _OPTION.match(text)
        if option and kind != "text":
            mark = option.group("mark") or " "
            options.append({"label": option.group("label"), "checked": mark.lower() == "x"})
        else:
            prompt.append(text)

    return {
        "id": question_id,
        "kind": kind,
        "prompt": "\n".join(prompt).strip(),
        "options": options,
        "line": line,
    }
