"""In-flight PV reservations: a sandbox paired with a PV, excluded locally while a just-patched PV still reads Available."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass


class AlreadyClaimed(RuntimeError):
    """A reservation conflicts with one that already stands."""


@dataclass(frozen=True)
class Reservation:
    """A held PV and who holds it."""

    pv: str
    sandbox: str
    expires_at: float


class Reservations:
    """In-flight (sandbox ↔ PV) reservations, each expiring after `ttl_seconds`."""

    def __init__(self, ttl_seconds: float = 120.0, clock=time) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._by_pv: dict[str, Reservation] = {}
        self._by_sandbox: dict[str, Reservation] = {}

    def claim(self, pv: str, sandbox: str) -> Reservation:
        """Reserve `pv` for `sandbox`, refreshing the deadline for the same pair and raising AlreadyClaimed if either side is taken."""
        with self._lock:
            now = self._clock.time()
            self._expire(now)

            mine = self._by_sandbox.get(sandbox)
            if mine is not None and mine.pv != pv:
                raise AlreadyClaimed(
                    f"sandbox {sandbox!r} already holds {mine.pv!r}; cannot also claim {pv!r}"
                )

            theirs = self._by_pv.get(pv)
            if theirs is not None and theirs.sandbox != sandbox:
                raise AlreadyClaimed(
                    f"PV {pv!r} is already claimed by sandbox {theirs.sandbox!r}"
                )

            res = Reservation(pv=pv, sandbox=sandbox, expires_at=now + self._ttl)
            self._by_pv[pv] = res
            self._by_sandbox[sandbox] = res
            return res

    def release(self, pv: str) -> None:
        """Give up the reservation on `pv` in both directions, idempotently."""
        with self._lock:
            res = self._by_pv.pop(pv, None)
            if res is not None and self._by_sandbox.get(res.sandbox) is res:
                del self._by_sandbox[res.sandbox]

    def get_pv_owner(self, pv: str) -> str | None:
        """Which sandbox holds `pv`, if any. Expired reservations read as free."""
        with self._lock:
            self._expire(self._clock.time())
            res = self._by_pv.get(pv)
            return res.sandbox if res else None

    def get_pv_for_pod(self, sandbox: str) -> str | None:
        """Which PV `sandbox` holds, if any. Expired reservations read as free."""
        with self._lock:
            self._expire(self._clock.time())
            res = self._by_sandbox.get(sandbox)
            return res.pv if res else None

    def in_flight_reservations(self) -> set[str]:
        """Reserved PV names, a read-only view that is no substitute for claim()."""
        with self._lock:
            self._expire(self._clock.time())
            return set(self._by_pv)

    def _expire(self, now: float) -> None:
        """Drop lapsed reservations from both indexes; the caller holds the lock."""
        stale = [pv for pv, res in self._by_pv.items() if res.expires_at <= now]
        for pv in stale:
            res = self._by_pv.pop(pv)
            # Only if the sandbox index still points at this reservation.
            if self._by_sandbox.get(res.sandbox) is res:
                del self._by_sandbox[res.sandbox]

