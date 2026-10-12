"""aws's authz object namespace, which the approve-time check and the startup seeding must spell identically or every approval is denied."""

from __future__ import annotations

from scooter_contrib_aws.objects import aws_account_object


def test_object_id_spelling():
    assert aws_account_object("dev") == "aws_account:dev"


def test_seeding_and_checking_agree_on_the_spelling():
    """Both call sites must derive the id the same way."""
    alias = "readonly-sandbox"
    assert aws_account_object(alias) == f"aws_account:{alias}"
