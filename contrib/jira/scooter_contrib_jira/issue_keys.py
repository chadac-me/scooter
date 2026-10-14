"""Jira's issue-key grammar: finding `ENG-42` in free text.

Pure text handling with no settings, store or FastAPI, so another integration
(gitlab reads keys out of MR titles and branches) can depend on it without
dragging a route in.
"""

from __future__ import annotations

import re

# PROJECT-123, where the project part is upper-case alphanumeric starting with a letter.
_KEY_RE = re.compile(r"\b([A-Z][A-Z0-9]+-\d+)\b")

# Jira issue numbers start at 1, so a `-0` tail (RELEASE-0, v2-0) is never a ticket.
_EXCLUDE_RE = re.compile(r"-0+$")


def extract_issue_keys(*texts: str) -> list[str]:
    """Every Jira key mentioned across `texts`, first mention first, de-duplicated."""
    keys: list[str] = []
    seen: set[str] = set()
    for text in texts:
        for match in _KEY_RE.findall(text or ""):
            if match not in seen and not _EXCLUDE_RE.search(match):
                keys.append(match)
                seen.add(match)
    return keys
