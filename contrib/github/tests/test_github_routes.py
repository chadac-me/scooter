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


def test_forge_proxy_intercepts_github_hosts():
    from scooter_broker_lib.forge import ALLOW_ALL, find_forge_hosts

    provider = github()
    forge = find_forge_hosts(provider)
    assert forge is not None
    assert {h.host for h in forge.hosts} == {"github.com", "api.github.com", "uploads.github.com"}
    assert [h.host for h in forge.hosts if h.git] == ["github.com"]
    assert forge.dialect == "github"
    assert provider.forge_policy is ALLOW_ALL


def test_gh_graphql_creates_are_linked():
    from scooter_broker_lib.forge import find_forge_hosts

    rules = find_forge_hosts(github()).graphql_link_rules
    pr = rules["createPullRequest"]({"pullRequest": {"url": "https://github.com/o/r/pull/7", "title": "T"}})
    assert (pr.resource_type, pr.url, pr.title) == ("pr", "https://github.com/o/r/pull/7", "T")
    assert rules["createIssue"]({"issue": {"url": "https://github.com/o/r/issues/8"}}).resource_type == "issue"
    assert rules["createPullRequest"]({"pullRequest": None}) is None


def test_forge_policy_is_loaded_from_settings(monkeypatch):
    monkeypatch.setenv("GITHUB_FORGE_POLICY", "scooter_broker_lib.forge:AllowAll")
    from scooter_broker_lib.forge import AllowAll

    assert isinstance(github().forge_policy, AllowAll)
