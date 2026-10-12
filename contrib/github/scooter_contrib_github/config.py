"""GitHub settings, owned by this contrib; the deployment-wide trigger policy is read through scooter_webhooks_lib.policy instead."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class GitHubSettings(ScooterBaseSettings):
    # The GitHub App, preferred: the broker mints an installation token from these and webhooks mints one per repo.
    github_app_id: str = ""
    github_app_private_key: str = ""  # PEM content or a path to a .pem file
    # Broker only; webhooks looks the installation up per repo instead.
    github_app_installation_id: int = 0

    # PAT fallback when github_app_* is unset, and the optional token on the public email lookup.
    github_token: str = ""

    github_enabled: bool = False
    github_webhook_secret: str = ""


settings = GitHubSettings()
