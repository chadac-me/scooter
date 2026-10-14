"""The in-tree providers' shapes: `conversation_map` holds ("issue", "ENG-42") and `resource_links` holds ("ticket", the browse URL), and the two must resolve to each other."""

import webhooks.resource_shapes  # noqa: F401  (registers the shapes under test)
from scooter_webhooks_lib.resources import (
    canonical_link,
    canonical_resource_type,
    link_variants,
    resource_id_variants,
)


def test_jira_browse_url_offers_the_issue_key():
    assert "ENG-42" in resource_id_variants(
        "jira", "issue", "https://acme.atlassian.net/browse/ENG-42"
    )


def test_the_callers_own_shape_is_tried_first():
    assert link_variants("jira", "ticket", "ENG-1")[0] == ("ticket", "ENG-1")


def test_an_unparseable_id_invents_no_url():
    # An id that names nothing known must not resolve to someone else's resource.
    assert resource_id_variants("jira", "issue", "not-a-resource-id") == ["not-a-resource-id"]


def test_type_aliases_are_two_way():
    assert canonical_resource_type("jira", "ticket") == "issue"
    # An unknown type passes through.
    assert canonical_resource_type("jira", "epic") == "epic"


def test_canonical_link_keeps_an_id_it_cannot_widen():
    # There is no jira site base for a bare key, so no tenant is invented.
    assert canonical_link("jira", "ticket", "ENG-9") == ("issue", "ENG-9")
