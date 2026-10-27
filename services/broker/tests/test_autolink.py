"""The auto-linking mechanism: the transport posts a link on a 2xx create, driven by a stand-in rule rather than any provider's real ones."""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.transports.http_proxy import HttpProxy


_CREATE_RULES = [
    rule(
        "POST", r"^repos/[^/]+/[^/]+/pulls/?$",
        lambda r: Link(source="test", resource_type="pr", url=r.get("html_url", ""), title=r.get("title")),
    ),
]


# ---- the transport posts a link on a 2xx create, and not otherwise ----


@pytest.mark.asyncio
async def test_maybe_autolink_posts_on_match(monkeypatch):
    posted: list = []

    async def fake_post_link(agent_host_url, conversation_id, link):
        posted.append((agent_host_url, conversation_id, link))

    import scooter_broker_lib.transports.http_proxy as hp
    monkeypatch.setattr(hp, "post_link", fake_post_link)

    proxy = HttpProxy(
        upstream="https://api.example.com",
        link_rules=_CREATE_RULES,
        agent_host_url="http://agent-host:8080",
    )
    resp = httpx.Response(201, json={"html_url": "https://example.com/a/b/pull/1", "title": "T"})
    await proxy._maybe_autolink("POST", "repos/a/b/pulls", resp, "conv-1")

    assert len(posted) == 1
    _, conv, link = posted[0]
    assert conv == "conv-1"
    assert link.url == "https://example.com/a/b/pull/1"


@pytest.mark.asyncio
async def test_maybe_autolink_ignores_non_matching_path(monkeypatch):
    posted: list = []
    import scooter_broker_lib.transports.http_proxy as hp
    monkeypatch.setattr(hp, "post_link", lambda *a: posted.append(a))
    proxy = HttpProxy(upstream="x", link_rules=_CREATE_RULES, agent_host_url="http://h")
    # A comment POST matches no create rule.
    resp = httpx.Response(201, json={"html_url": "https://example.com/a/b/issues/1#c"})
    await proxy._maybe_autolink("POST", "repos/a/b/issues/1/comments", resp, "conv-1")
    assert posted == []


@pytest.mark.asyncio
async def test_maybe_autolink_swallows_bad_response(monkeypatch):
    # A non-JSON body must not raise.
    import scooter_broker_lib.transports.http_proxy as hp
    monkeypatch.setattr(hp, "post_link", lambda *a: None)
    proxy = HttpProxy(upstream="x", link_rules=_CREATE_RULES, agent_host_url="http://h")
    resp = httpx.Response(201, content=b"not json")
    await proxy._maybe_autolink("POST", "repos/a/b/pulls", resp, "conv-1")  # must not raise


def _capture_client(monkeypatch, seen: list[httpx.Request]) -> None:
    import scooter_broker_lib.autolink as al

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, json={"links": []})

    real = httpx.AsyncClient
    monkeypatch.setattr(al.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))


@pytest.mark.parametrize("mounted", [True, False])
async def test_router_calls_carry_the_router_token_when_mounted(monkeypatch, tmp_path, mounted):
    import scooter_broker_lib.autolink as al
    from scooter_lib.svcauth import TokenSource

    path = tmp_path / "token"
    if mounted:
        path.write_text("router-sa-token\n")
    monkeypatch.setattr(al, "_router_token", TokenSource(path))
    seen: list[httpx.Request] = []
    _capture_client(monkeypatch, seen)

    link = Link(source="github", resource_type="pr", url="https://example.com/a/b/pull/1")
    await al.post_link("http://router", "c1", link)
    await al.create_link("http://router", "c1", link)
    await al.list_links("http://router", "c1")

    assert len(seen) == 3
    want = "Bearer router-sa-token" if mounted else None
    assert [r.headers.get("authorization") for r in seen] == [want] * 3


async def test_an_unreadable_router_token_does_not_break_a_link(monkeypatch, tmp_path):
    import scooter_broker_lib.autolink as al
    from scooter_lib.svcauth import TokenSource

    monkeypatch.setattr(al, "_router_token", TokenSource(tmp_path))  # a directory: read fails
    seen: list[httpx.Request] = []
    _capture_client(monkeypatch, seen)
    await al.post_link("http://router", "c1", Link(source="github", resource_type="pr", url="https://x/pull/1"))
    assert len(seen) == 1 and "authorization" not in seen[0].headers
