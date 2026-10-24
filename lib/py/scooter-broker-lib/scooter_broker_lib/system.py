"""The system-task caller behind a contrib's ``/<contrib>/system/*`` routes.

A system task (``scooter.systemTasks``) runs in the scheduler pod and calls the broker as
the scheduler's service account; the core recognises it from
``SYSTEM_TASK_SERVICE_ACCOUNTS`` and sets ``Identity.is_system_task``. A route that only
a task may call depends on this::

    system = system_task_identity(authed)

    @router.get("/system/eligible", dependencies=[Depends(system)])
    async def eligible(...): ...
"""

from __future__ import annotations

from typing import Awaitable, Callable

from fastapi import Depends, HTTPException

from .types import AuthDependency, Identity


def system_task_identity(authed: AuthDependency) -> Callable[..., Awaitable[Identity]]:
    """A FastAPI dependency returning the caller's Identity, or 403 unless it is a system task."""

    async def _system(identity: Identity = Depends(authed)) -> Identity:
        if not identity.is_system_task:
            raise HTTPException(status_code=403, detail="system routes are reachable only by a system task")
        return identity

    return _system
