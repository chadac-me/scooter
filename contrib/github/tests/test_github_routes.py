"""The github provider's git-credentials route must not be shadowed by its HttpProxy catch-all.

FastAPI matches in registration order, so the GitCredential transport must precede
the HttpProxy one or /github/git-credentials is forwarded to api.github.com.
"""

from __future__ import annotations

from scooter_contrib_github.broker_provider import github
from scooter_broker_lib.transports.git_credential import GitCredential
from scooter_broker_lib.transports.http_proxy import HttpProxy


def test_git_credential_transport_precedes_proxy():
    provider = github()
    kinds = [type(t).__name__ for t in provider.transports]
    assert "GitCredential" in kinds, kinds
    assert "HttpProxy" in kinds, kinds
    assert kinds.index("GitCredential") < kinds.index("HttpProxy"), (
        f"GitCredential must come before HttpProxy, got {kinds}"
    )


def test_git_credential_serves_github_host():
    provider = github()
    gc = next(t for t in provider.transports if isinstance(t, GitCredential))
    assert gc.host == "github.com"
    assert gc.username == "x-access-token"


def test_proxy_targets_github_api():
    provider = github()
    proxy = next(t for t in provider.transports if isinstance(t, HttpProxy))
    assert "api.github.com" in proxy.upstream


def test_git_credentials_are_vended_by_the_app_source(monkeypatch):
    """The generic GitCredential transport reads a GitHubAppSource as provider.credential."""
    from scooter_contrib_github.github_app import GitHubAppSource

    monkeypatch.setenv("GITHUB_APP_ID", "123")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----")
    monkeypatch.setenv("GITHUB_APP_INSTALLATION_ID", "42")

    provider = github()
    assert provider.enabled
    assert isinstance(provider.credential, GitHubAppSource)
    assert provider.credential.installation_id == 42
