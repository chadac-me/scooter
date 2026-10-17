"""The annotations transport: the viewer's sync endpoint, mounted under /files/*.

    PUT    /files/annotations/{id}                 store one (idempotent)
    GET    /files/annotations                      this conversation's annotations (?path=&thread=&resolved=)
    GET    /files/annotations/{id}                 one annotation
    POST   /files/annotations/threads/{t}/resolve  resolve or reopen a whole thread
    DELETE /files/annotations/{id}                 delete one

Every route resolves the conversation from the authenticated identity rather than
the body, so a sandbox can only read and write its own conversation's annotations;
a conversation in the payload that disagrees is a 403, not a silent re-scope. That
`authed` dependency is the only thing the broker core contributes here.

PUT rather than POST because the caller supplies the id: the viewer retries from an
outbox, and an idempotent verb is what makes a lost ack free to retry.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from scooter_broker_lib.types import AuthDependency, Identity, Provider, Transport

from .store import AGENT_AUTHOR, KINDS, Anchor, Annotation, AnnotationStore

logger = logging.getLogger(__name__)

_MAX_TEXT_BYTES = 64 * 1024
_MAX_QUOTE_BYTES = 4 * 1024


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require(body: dict, field_name: str) -> str:
    value = body.get(field_name)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status_code=400, detail=f"{field_name} is required")
    return value


def _parse(body: dict, *, annotation_id: str, conversation_id: str) -> Annotation:
    """Validate a payload into an Annotation, or raise a 4xx."""
    claimed = body.get("conversation")
    if claimed and claimed != conversation_id:
        # The sandbox SA names exactly one conversation, so this is a caller bug or
        # an attempt to write into someone else's thread. Neither should look like success.
        raise HTTPException(
            status_code=403, detail="conversation does not match the authenticated sandbox"
        )

    kind = body.get("kind") or "comment"
    if kind not in KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {sorted(KINDS)}")

    text = _require(body, "text")
    if len(text.encode()) > _MAX_TEXT_BYTES:
        raise HTTPException(status_code=400, detail="text is too long")

    anchor_raw = body.get("anchor")
    if not isinstance(anchor_raw, dict):
        raise HTTPException(status_code=400, detail="anchor is required")
    line = anchor_raw.get("line")
    if not isinstance(line, int) or isinstance(line, bool) or line < 1:
        raise HTTPException(status_code=400, detail="anchor.line must be a positive integer")
    quote = anchor_raw.get("quote") or ""
    if not isinstance(quote, str):
        raise HTTPException(status_code=400, detail="anchor.quote must be a string")
    if len(quote.encode()) > _MAX_QUOTE_BYTES:
        raise HTTPException(status_code=400, detail="anchor.quote is too long")

    by = body.get("by") or "reviewer"
    if by not in ("reviewer", "agent"):
        raise HTTPException(status_code=400, detail="by must be reviewer or agent")

    question_id = body.get("question_id") or ""
    if kind == "answer" and not question_id:
        # An answer with nothing to answer cannot be rendered against its question.
        raise HTTPException(status_code=400, detail="an answer needs a question_id")

    return Annotation(
        id=annotation_id,
        conversation_id=conversation_id,
        path=_require(body, "path"),
        anchor=Anchor(line=line, quote=quote),
        kind=kind,
        text=text,
        # A remark with no thread of its own starts one, which is the common case:
        # the first comment on a line.
        thread=body.get("thread") or annotation_id,
        author=AGENT_AUTHOR if by == "agent" else conversation_id,
        question_id=question_id,
        resolved=bool(body.get("resolved", False)),
        created_at=body.get("created_at") or "",
    )


@dataclass
class Annotations(Transport):
    """Routes over an AnnotationStore, which the provider injects."""

    name: str = "annotations"
    # Injected via set_store, so tests can use SQLite.
    store: AnnotationStore | None = field(default=None)

    def set_store(self, store: AnnotationStore) -> None:
        self.store = store

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter(prefix="/annotations", tags=["annotations"])

        def _store() -> AnnotationStore:
            if self.store is None:
                raise HTTPException(status_code=503, detail="annotations not configured")
            return self.store

        @router.put("/{annotation_id}")
        async def put_annotation(
            annotation_id: str,
            body: dict = Body(...),
            identity: Identity = Depends(authed),
        ) -> dict:
            annotation = _parse(
                body, annotation_id=annotation_id, conversation_id=identity.conversation_id
            )
            try:
                stored, created = await _store().upsert(annotation, now_iso=_now_iso())
            except PermissionError as exc:
                raise HTTPException(status_code=403, detail=str(exc)) from exc

            # Only stores; the viewer wakes the conversation after this ack.
            return {"annotation": stored.payload(), "created": created}

        @router.get("")
        async def list_annotations(
            path: str = Query(default=""),
            thread: str = Query(default=""),
            resolved: bool | None = Query(default=None),
            identity: Identity = Depends(authed),
        ) -> dict:
            items = await _store().list(
                identity.conversation_id, path=path, thread=thread, resolved=resolved
            )
            return {"annotations": [a.payload() for a in items]}

        @router.get("/{annotation_id}")
        async def get_annotation(
            annotation_id: str, identity: Identity = Depends(authed)
        ) -> dict:
            found = await _store().get(annotation_id)
            # Another conversation's annotation is a 404, not a 403: whether an id exists
            # elsewhere is not this caller's to learn.
            if found is None or found.conversation_id != identity.conversation_id:
                raise HTTPException(status_code=404, detail="no such annotation")
            return {"annotation": found.payload()}

        @router.post("/threads/{thread}/resolve")
        async def resolve_thread(
            thread: str,
            body: dict = Body(default={}),
            identity: Identity = Depends(authed),
        ) -> dict:
            resolved = bool(body.get("resolved", True))
            count = await _store().resolve_thread(
                identity.conversation_id, thread, resolved=resolved, now_iso=_now_iso()
            )
            if count == 0:
                raise HTTPException(status_code=404, detail="no such thread")
            return {"thread": thread, "resolved": resolved, "updated": count}

        @router.delete("/{annotation_id}")
        async def delete_annotation(
            annotation_id: str, identity: Identity = Depends(authed)
        ) -> dict:
            try:
                gone = await _store().delete(
                    annotation_id, conversation_id=identity.conversation_id
                )
            except PermissionError:
                raise HTTPException(status_code=404, detail="no such annotation") from None
            if not gone:
                raise HTTPException(status_code=404, detail="no such annotation")
            return {"deleted": annotation_id}

        return router
