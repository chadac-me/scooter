"""whoami transport: the diagnostic transport at `/{provider}/whoami`, which authenticates the caller like every real transport and returns the validated Identity."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, Depends

from ..types import AuthDependency, Identity, Provider, Transport


@dataclass
class WhoAmI(Transport):
    recorder: object | None = None     # records each authenticated Identity
    name: str = "whoami"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()
        recorder = self.recorder

        @router.get("/whoami")
        async def whoami(identity: Identity = Depends(authed)) -> dict[str, str]:
            if recorder is not None and hasattr(recorder, "record"):
                recorder.record(identity)  # type: ignore[attr-defined]
            return {
                "conversation_id": identity.conversation_id,
                "namespace": identity.namespace,
                "service_account": identity.service_account,
            }

        return router
