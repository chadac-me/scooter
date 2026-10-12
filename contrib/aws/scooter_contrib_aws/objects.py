"""aws's own authz object namespace; the object half of a tuple belongs to the provider, the user half to the surface."""

from __future__ import annotations


def aws_account_object(account: str) -> str:
    """The OpenFGA object id for an AWS account (registry alias)."""
    return f"aws_account:{account}"
