"""Download files attached to a Slack message so they reach the agent.

Attachments are split three ways: images become multimodal image parts, text files
are inlined into the message as fenced blocks, and binary files become file parts
the agent-host writes into the sandbox. Best-effort throughout: a file that cannot
be downloaded, is over the size cap or lacks a URL is skipped and logged.
"""

from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass, field

import httpx

from .config import settings
from scooter_lib.logging_config import format_error

logger = logging.getLogger(__name__)
_C = {"component": "handlers.slack_files"}

# Mirrors the agent-host AssetStore allow-list.
_ALLOWED_MIME = {"image/png", "image/jpeg", "image/gif", "image/webp"}

# Extensions treated as text, mapped to a fenced-code language hint (empty for a plain fence).
_TEXT_EXT_LANG = {
    ".txt": "",
    ".md": "markdown",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".log": "",
    ".csv": "",
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".sh": "bash",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".nix": "nix",
    ".toml": "toml",
    ".html": "html",
    ".css": "css",
    ".xml": "xml",
}


@dataclass
class DownloadedFiles:
    """The split result of a Slack message's `files` array: image parts, the inlined text block, and binary file parts."""

    images: list[dict] = field(default_factory=list)
    inline_text: str = ""
    file_parts: list[dict] = field(default_factory=list)


def _image_max_bytes() -> int:
    return getattr(settings, "image_max_bytes", 5 * 1024 * 1024)


def _file_max_bytes() -> int:
    return getattr(settings, "file_max_bytes", _image_max_bytes())


def _cap_for(f: dict) -> int:
    """Size cap for a file: the image cap for images, the general file cap otherwise."""
    mimetype = (f.get("mimetype") or "").lower()
    return _image_max_bytes() if mimetype in _ALLOWED_MIME else _file_max_bytes()


def _is_text_file(f: dict) -> bool:
    """True when the mimetype is text/*, the extension is a known text extension, or Slack flagged it as a snippet."""
    mimetype = (f.get("mimetype") or "").lower()
    if mimetype.startswith("text/"):
        return True
    name = f.get("name") or ""
    _, ext = os.path.splitext(name.lower())
    if ext in _TEXT_EXT_LANG:
        return True
    if f.get("mode") == "snippet":
        return True
    filetype = (f.get("filetype") or "").lower()
    if filetype in ("text", "snippet", "post"):
        return True
    return False


def _lang_hint(name: str, filetype: str = "") -> str:
    """A fenced-code language hint from the extension, falling back to Slack's `filetype`."""
    _, ext = os.path.splitext((name or "").lower())
    lang = _TEXT_EXT_LANG.get(ext)
    if lang is not None:
        return lang
    return (filetype or "").lower()


def _inline_block(name: str, content: str, lang: str) -> str:
    """Build the fenced `[Attached file: <name>]` block for a text file."""
    fence_lang = lang or ""
    # Content that itself contains a fence gets a longer one.
    fence = "```"
    while fence in content:
        fence += "`"
    return f"[Attached file: {name}]\n{fence}{fence_lang}\n{content}\n{fence}"


async def download_files(files: list[dict] | None) -> DownloadedFiles:
    """Fetch and split a Slack message's `files`, skipping what cannot be downloaded or is over the cap."""
    result = DownloadedFiles()
    if not files:
        return result
    token = settings.slack_bot_token
    if not token:
        logger.warning(
            "message has files but slack bot token is unset, cannot download",
            extra={**_C, "file_count": len(files)},
        )
        return result

    text_blocks: list[str] = []

    async with httpx.AsyncClient(timeout=30) as client:
        for f in files:
            name = f.get("name") or "file"
            mimetype = (f.get("mimetype") or "").lower()
            max_bytes = _cap_for(f)

            size = f.get("size")
            if isinstance(size, int) and size > max_bytes:
                logger.info(
                    "file over size cap, skipping",
                    extra={
                        **_C,
                        "file_name": name,
                        "size_bytes": size,
                        "max_bytes": max_bytes,
                        "size_from": "declared",
                    },
                )
                continue

            url = f.get("url_private_download") or f.get("url_private")
            if not url:
                continue

            try:
                resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
                resp.raise_for_status()
                data = resp.content
            except httpx.HTTPError as e:
                logger.warning(
                    "file download failed",
                    extra={**_C, "file_name": name, "error": format_error(e)},
                )
                continue

            if len(data) > max_bytes:
                logger.info(
                    "file over size cap, skipping",
                    extra={
                        **_C,
                        "file_name": name,
                        "size_bytes": len(data),
                        "max_bytes": max_bytes,
                        "size_from": "downloaded",
                    },
                )
                continue

            if mimetype in _ALLOWED_MIME:
                result.images.append(
                    {"data": base64.b64encode(data).decode("ascii"), "mimeType": mimetype}
                )
            elif _is_text_file(f):
                try:
                    text = data.decode("utf-8")
                except UnicodeDecodeError:
                    # Not valid UTF-8 after all, so forward it as a binary part rather than mangle it.
                    logger.info(
                        "file is not valid utf-8, forwarding as a binary attachment",
                        extra={**_C, "file_name": name, "mime_type": mimetype},
                    )
                    result.file_parts.append(
                        {
                            "name": name,
                            "data": base64.b64encode(data).decode("ascii"),
                            "mimeType": mimetype or "application/octet-stream",
                        }
                    )
                    continue
                text_blocks.append(_inline_block(name, text, _lang_hint(name, f.get("filetype") or "")))
            else:
                result.file_parts.append(
                    {
                        "name": name,
                        "data": base64.b64encode(data).decode("ascii"),
                        "mimeType": mimetype or "application/octet-stream",
                    }
                )

    result.inline_text = "\n\n".join(text_blocks)
    return result


async def download_images(files: list[dict] | None) -> list[dict]:
    """The image parts only."""
    return (await download_files(files)).images
