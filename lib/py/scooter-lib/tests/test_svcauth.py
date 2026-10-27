"""scooter_lib.svcauth: the verdict cache, principal rules and token rotation."""

from __future__ import annotations

import asyncio

import pytest

from scooter_lib.svcauth import (
    CACHE_TTL_S, AuthError, Policy, Review, TokenSource, Verifier, bearer_token, parse_allowlist, sandbox_id,
)

NS = "agent-sandbox"
WEBHOOKS = f"system:serviceaccount:{NS}:agent-webhooks"
BROKER = f"system:serviceaccount:{NS}:agent-broker"
SANDBOX = f"system:serviceaccount:{NS}:sandbox-abc123"
KNOWN = {"wh": WEBHOOKS, "br": BROKER, "sb": SANDBOX, "other": "system:serviceaccount:other:sandbox-x"}


class _Fake:
    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, token: str) -> Review:
        self.calls += 1
        if token == "boom":
            raise RuntimeError("apiserver down")
        return Review(ok=True, username=KNOWN[token]) if token in KNOWN else Review(ok=False)


def _auth(token: str, **extra: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}", **extra}


POLICY = Policy(services=parse_allowlist(BROKER), asserters=parse_allowlist(WEBHOOKS), sandbox_namespace=NS)
USER = {"x-scooter-user": "chadac", "x-scooter-user-email": "c@example.com"}


def _resolve(headers: dict[str, str]):
    return asyncio.run(Verifier(_Fake()).resolve(headers, POLICY))


def test_caches_accepts_and_rejects_for_the_ttl() -> None:
    fake, t = _Fake(), [0.0]
    v = Verifier(fake, now=lambda: t[0])

    async def run() -> None:
        for token in ("wh", "wh", "nope", "nope"):
            await v.verify(token)
        assert fake.calls == 2
        t[0] = CACHE_TTL_S
        await v.verify("wh")
        assert fake.calls == 3

    asyncio.run(run())


def test_never_caches_review_errors() -> None:
    fake = _Fake()
    v = Verifier(fake)
    for _ in range(2):
        with pytest.raises(RuntimeError):
            asyncio.run(v.verify("boom"))
    assert fake.calls == 2


def test_an_asserter_names_a_user() -> None:
    p = _resolve(_auth("wh", **USER))
    assert (p.kind, p.service_account, p.user, p.email) == ("service", WEBHOOKS, "chadac", "c@example.com")


def test_a_plain_service_cannot_name_a_user() -> None:
    p = _resolve(_auth("br", **USER))
    assert (p.kind, p.user, p.email) == ("service", "", "")


def test_a_sandbox_binds_to_its_id_only_in_the_namespace() -> None:
    p = _resolve(_auth("sb", **USER))
    assert (p.kind, p.sandbox_id, p.user) == ("sandbox", "abc123", "")
    with pytest.raises(AuthError) as e:
        _resolve(_auth("other"))
    assert (e.value.code, e.value.status) == ("not-allowed", 403)


@pytest.mark.parametrize(("headers", "code", "status"), [
    ({}, "no-token", 401),
    (_auth("nope"), "unauthenticated", 401),
    (_auth("boom"), "review-failed", 503),
])
def test_rejections(headers: dict[str, str], code: str, status: int) -> None:
    with pytest.raises(AuthError) as e:
        _resolve(headers)
    assert (e.value.code, e.value.status) == (code, status)


def test_helpers() -> None:
    assert bearer_token({"authorization": "bearer  t "}) == "t"
    assert bearer_token({"authorization": "Basic t"}) == ""
    assert sandbox_id(SANDBOX, NS) == "abc123"
    assert sandbox_id(SANDBOX, "") == ""
    assert sandbox_id(BROKER, NS) == ""


def test_token_source_rereads_a_rotated_token(tmp_path) -> None:
    path, t = tmp_path / "token", [0.0]
    path.write_text("one\n")
    s = TokenSource(path, refresh_s=1.0, now=lambda: t[0])
    assert s.headers("chadac") == {"Authorization": "Bearer one", "x-scooter-user": "chadac"}
    path.write_text("two\n")
    assert s.current() == "one"
    t[0] = 1.0
    assert s.current() == "two"


def test_token_source_without_a_mounted_token(tmp_path) -> None:
    assert TokenSource(tmp_path / "missing").headers() == {}
