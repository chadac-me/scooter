"""The files viewer: a read-only HTTP view of the sandbox workspace.

Runs INSIDE the sandbox, so listing and reading are ordinary local filesystem calls
and there is no file-read endpoint on the control plane to secure. The agent-host
reverse-proxies it at /c/<conversation>/files/ and does NOT strip that prefix, so
every route is resolved after `base` is removed and every link the page emits is
rooted at `base`.

Stdlib only, deliberately: this ships in the sandbox image, where a FastAPI/uvicorn
closure would be paid for by every conversation whether or not anyone opens the
viewer.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import posixpath
import urllib.parse
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATIC = Path(__file__).resolve().parent / "static"

# A file past this is served as metadata only: the viewer renders text, and a
# multi-megabyte blob is a download, not something to read in a browser.
MAX_READ_BYTES = 2 * 1024 * 1024

# /api/raw backs <img>: the limit is what a page can inline, not what reads as text.
MAX_RAW_BYTES = 16 * 1024 * 1024

# Only these are served as bytes; widening it makes /api/raw a download endpoint
# for the whole workspace. Why that is not wanted: PR #772.
RAW_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico", ".bmp"}

# Directories that are never interesting to review and enormous to walk.
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache", "result"}

# Dotfiles are noise in a review view, with two exceptions worth reading.
SHOW_DOTS = {".github", ".scooter"}


@dataclass(frozen=True)
class Config:
    """Everything the unit passes in, resolved once at startup rather than per
    request — and a seam, so a test configures a viewer instead of re-importing
    this module with a different environment."""

    root: Path
    base: str
    port: int
    # The pinned browser assets (deps.nix), built separately from this tree.
    # Absent is supported: the page falls back to its plain renderer.
    vendor: Path | None = None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Config:
        env = os.environ if env is None else env
        vendor = env.get("SCOOTER_FILES_VENDOR", "")
        return cls(
            root=Path(env.get("SCOOTER_FILES_ROOT", "/workspace")).resolve(),
            # Trailing slash stripped: every route is formed as base + "/…", so a
            # slash here would double up in all of them.
            base=env.get("SCOOTER_FILES_BASE", "").rstrip("/"),
            port=int(env.get("SCOOTER_FILES_PORT", "7801")),
            # A checkout can drop assets in static/vendor/ for the same page.
            vendor=Path(vendor).resolve() if vendor else STATIC / "vendor",
        )


def resolve(root: Path, rel: str) -> Path:
    """Resolve a request path under `root`, raising ValueError if it escapes.

    Escapes are refused even though this is not a trust boundary — whoever reaches
    this service has the terminal on the same pod — because a viewer that can be
    walked up to `/` turns every stray `../` in a link into a confusing 200.
    """
    candidate = (root / rel.lstrip("/")).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("path escapes the workspace root")
    return candidate


def rel_of(root: Path, path: Path) -> str:
    return "" if path == root else str(path.relative_to(root))


def listing(root: Path, path: Path) -> dict:
    """One directory, directories first, with a flag for git repos."""
    entries = []
    with os.scandir(path) as it:
        for entry in it:
            if entry.name.startswith(".") and entry.name not in SHOW_DOTS:
                continue
            try:
                is_dir = entry.is_dir()
            except OSError:
                is_dir = False
            try:
                size = None if is_dir else entry.stat(follow_symlinks=False).st_size
            except OSError:
                size = None
            entries.append(
                {
                    "name": entry.name,
                    "kind": "dir" if is_dir else "file",
                    "size": size,
                    "skip": entry.name in SKIP_DIRS,
                    # The diff renderer is not built yet; this is the flag it keys on.
                    "repo": is_dir and (Path(entry.path) / ".git").exists(),
                }
            )
    entries.sort(key=lambda e: (e["kind"] != "dir", e["name"].lower()))
    return {"path": rel_of(root, path), "entries": entries}


def read_file(root: Path, path: Path) -> dict:
    """One file as text, or metadata explaining why it is not being rendered."""
    size = path.stat().st_size
    out = {"path": rel_of(root, path), "size": size, "body": "", "renderer": "code"}
    if size > MAX_READ_BYTES:
        return out | {"renderer": "too-large"}

    raw = path.read_bytes()
    # A NUL in the first block is the cheap binary test every pager uses.
    if b"\0" in raw[:8192]:
        return out | {"renderer": "binary"}

    body = raw.decode("utf-8", errors="replace")
    return out | {
        "body": body,
        "lines": body.count("\n") + 1,
        "etag": hashlib.sha256(raw).hexdigest()[:16],
        # Which of the page's renderers gets the body; markdown is parsed in the
        # browser, where the sanitizer that must see the result lives.
        "renderer": "markdown" if path.suffix in {".md", ".markdown"} else "code",
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "scooter-files/0.1"
    protocol_version = "HTTP/1.1"

    @property
    def cfg(self) -> Config:
        return self.server.cfg  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:
        # Journald already timestamps; the default handler's stderr format double-stamps.
        print(f"files-viewer {fmt % args}", flush=True)

    # --- replies ----------------------------------------------------------------

    def send_body(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_body(status, json.dumps(payload).encode(), "application/json")

    def fail(self, status: HTTPStatus, message: str) -> None:
        self.send_json({"error": message}, status)

    # --- routing ----------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's casing
        parsed = urllib.parse.urlsplit(self.path)
        route = urllib.parse.unquote(parsed.path)

        base = self.cfg.base
        if base:
            # Traffic that skips the prefix is not this service's: the proxy always
            # sends the whole path, so a bare /api/list is someone else's request.
            if not (route == base or route.startswith(base + "/")):
                return self.fail(HTTPStatus.NOT_FOUND, "not under this service's base path")
            route = route[len(base):]
        route = posixpath.normpath(route or "/")

        want = (urllib.parse.parse_qs(parsed.query).get("path") or [""])[0]

        try:
            if route in ("/", "."):
                return self.serve_index()
            # Before /static/: the vendor assets are their own store path.
            if route.startswith("/static/vendor/"):
                return self.serve_vendor(route[len("/static/vendor/"):])
            if route.startswith("/static/"):
                return self.serve_static(route[len("/static/"):])
            if route == "/api/list":
                return self.serve_list(want)
            if route == "/api/file":
                return self.serve_file(want)
            if route == "/api/raw":
                return self.serve_raw(want)
            if route == "/api/health":
                return self.send_json(
                    {
                        "ok": True,
                        "root": str(self.cfg.root),
                        "base": base,
                        # First thing to check when a doc renders as plain text.
                        "vendor": self.vendor_dir is not None,
                    }
                )
        except ValueError as exc:
            return self.fail(HTTPStatus.BAD_REQUEST, str(exc))
        except FileNotFoundError:
            return self.fail(HTTPStatus.NOT_FOUND, "no such path")
        except PermissionError:
            return self.fail(HTTPStatus.FORBIDDEN, "permission denied")

        self.fail(HTTPStatus.NOT_FOUND, f"no route {route}")

    def serve_index(self) -> None:
        html = (STATIC / "index.html").read_text()
        # The page is served under the proxy prefix, so it cannot know its own base
        # at build time; inject it rather than guessing from location.pathname.
        html = html.replace("{{BASE}}", self.cfg.base)
        self.send_body(HTTPStatus.OK, html.encode(), "text/html; charset=utf-8")

    def serve_static(self, name: str) -> None:
        self.send_asset(STATIC, name)

    @property
    def vendor_dir(self) -> Path | None:
        """The vendor path, or None when the assets were never built."""
        vendor = self.cfg.vendor
        return vendor if vendor is not None and vendor.is_dir() else None

    def serve_vendor(self, name: str) -> None:
        vendor = self.vendor_dir
        if vendor is None:
            # 404, not 500: the page keys on it to render plain.
            return self.fail(HTTPStatus.NOT_FOUND, "vendor assets are not built into this viewer")
        self.send_asset(vendor, name)

    def send_asset(self, root: Path, name: str) -> None:
        target = (root / name).resolve()
        if root not in target.parents:
            raise ValueError("path escapes the asset directory")
        ctype, _ = mimetypes.guess_type(target.name)
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", ctype or "application/octet-stream")
        self.send_header("content-length", str(len(body)))
        # Immutable per image; re-fetching 280 kB per click is felt.
        self.send_header("cache-control", "public, max-age=3600")
        self.end_headers()
        self.wfile.write(body)

    def serve_list(self, want: str) -> None:
        target = resolve(self.cfg.root, want)
        if not target.exists():
            raise FileNotFoundError(want)
        if not target.is_dir():
            return self.fail(HTTPStatus.BAD_REQUEST, "not a directory")
        self.send_json(listing(self.cfg.root, target))

    def serve_file(self, want: str) -> None:
        target = resolve(self.cfg.root, want)
        if not target.exists():
            raise FileNotFoundError(want)
        if not target.is_file():
            return self.fail(HTTPStatus.BAD_REQUEST, "not a file")
        self.send_json(read_file(self.cfg.root, target))

    def serve_raw(self, want: str) -> None:
        """Bytes for an <img> in a rendered document, confined to image types."""
        target = resolve(self.cfg.root, want)
        if not target.exists():
            raise FileNotFoundError(want)
        if not target.is_file():
            return self.fail(HTTPStatus.BAD_REQUEST, "not a file")
        if target.suffix.lower() not in RAW_SUFFIXES:
            return self.fail(HTTPStatus.BAD_REQUEST, "not an image type this route serves")
        if target.stat().st_size > MAX_RAW_BYTES:
            return self.fail(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "image past the inline limit")
        ctype, _ = mimetypes.guess_type(target.name)
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", ctype or "application/octet-stream")
        self.send_header("content-length", str(len(body)))
        # An SVG is a document: inert, or it runs script in the viewer's origin.
        self.send_header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    # The proxy reconnects; a lingering socket on restart is worse than a dropped one.
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, cfg: Config):
        self.cfg = cfg
        super().__init__(("0.0.0.0", cfg.port), Handler)


def make_server(cfg: Config) -> Server:
    return Server(cfg)


def main() -> None:
    cfg = Config.from_env()
    if not cfg.root.is_dir():
        raise SystemExit(f"files viewer: root {cfg.root} is not a directory")
    httpd = make_server(cfg)
    print(
        f"files-viewer listening on 0.0.0.0:{httpd.server_address[1]} "
        f"root={cfg.root} base={cfg.base or '/'}",
        flush=True,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
