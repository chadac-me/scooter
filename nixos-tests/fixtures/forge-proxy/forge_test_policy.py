"""Denies pushes to acme/locked; allows everything else."""

from scooter_broker_lib.forge import Decision


class DenyLocked:
    async def check(self, request):
        if request.is_push and request.repo == "acme/locked":
            return Decision.deny("acme/locked is read-only in this test")
        return Decision.allow()
