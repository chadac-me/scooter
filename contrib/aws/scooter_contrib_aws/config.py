"""AWS settings, owned by this contrib.

The authorizer, this contrib's database connection and the approver allowlist are the
platform's and arrive through the BrokerContext and core auth, not from here.
"""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class AwsSettings(ScooterBaseSettings):
    aws_enabled: bool = False
    aws_region: str = "us-east-1"
    aws_sts_external_id: str = "agent-permissions-broker"
    # The principal the account registry's per-account broker_role_arn is assumed from.
    aws_broker_principal_arn: str = ""
    # Path to the account-registry JSON.
    aws_accounts_file: str = ""
    aws_role_ttl_hours: int = 12
    # Which identity claim ("email" | "id" | "name") authorizes an approver; must match how the FGA approver tuples are seeded.
    aws_approver_claim: str = "email"

    # Where to notify when a request is created so the agent-host raises the approval interrupt; empty disables the notify.
    aws_agent_host_url: str = ""
    aws_notify_attempts: int = 3
    aws_notify_backoff: float = 0.5

    # Seconds between sweeps for expired dynamic roles.
    aws_sweep_interval: int = 300


settings = AwsSettings()
