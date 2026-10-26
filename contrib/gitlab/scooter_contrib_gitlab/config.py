"""GitLab settings, owned by this contrib; the deployment-wide trigger policy is read through scooter_webhooks_lib.policy instead."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class GitlabSettings(ScooterBaseSettings):
    # The PAT the proxy injects, which also gates the provider.
    gitlab_token: str = ""
    # A `module:attr` ForgePolicy (scooter_broker_lib.forge) checked on every request the broker makes to GitLab; empty allows all.
    gitlab_forge_policy: str = ""

    gitlab_enabled: bool = True
    gitlab_webhook_secret: str = ""
    default_gitlab_repo: str = ""


settings = GitlabSettings()
