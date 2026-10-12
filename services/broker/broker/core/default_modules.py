"""Deployment-default module serving: GET /modules/default.tar.gz returns a gzipped tar of
the `.nix` files mounted at SANDBOX_DEFAULT_MODULES_DIR, which the sandbox pod
fetchTarballs and imports at re-converge.

Unauthenticated because the pod fetches it at boot and module Nix is not a secret; an
unset directory serves an empty tarball.
"""

from __future__ import annotations

import gzip
import io
import logging
import os
import tarfile

from fastapi import APIRouter
from fastapi.responses import Response

from ..config import settings

logger = logging.getLogger(__name__)


def _read_default_module_files() -> dict[str, str]:
    """{filename: content} for each `.nix` file directly in SANDBOX_DEFAULT_MODULES_DIR, or {} when it is unset or missing."""
    dir_path = settings.sandbox_default_modules_dir
    if not dir_path or not os.path.isdir(dir_path):
        return {}
    out: dict[str, str] = {}
    for fname in sorted(os.listdir(dir_path)):
        if not fname.endswith(".nix"):
            continue
        fpath = os.path.join(dir_path, fname)
        if not os.path.isfile(fpath):
            continue
        with open(fpath, encoding="utf-8") as fh:
            out[fname] = fh.read()
    return out


def _build_tarball(files: dict[str, str]) -> bytes:
    """Gzipped tar of each file at the tar root with a fixed mtime, so an unchanged set hashes the same."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for fname, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name=fname)
            info.size = len(data)
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)


def create_default_modules_router() -> APIRouter:
    router = APIRouter()

    @router.get("/modules/default.tar.gz")
    async def get_default_modules_tarball() -> Response:
        body = _build_tarball(_read_default_module_files())
        return Response(content=body, media_type="application/gzip")

    return router
