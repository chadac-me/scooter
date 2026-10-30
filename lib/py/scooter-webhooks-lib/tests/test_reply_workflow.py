"""The reply steps every forwarded forge comment carries."""

from scooter_webhooks_lib.reply_workflow import reply_workflow


def test_react_comes_first_then_plan_then_results():
    text = reply_workflow("github_comment", "scooter-github")
    react, plan, done = (text.index(s) for s in ("React 👀 first", "comment your plan", "comment with the results"))
    assert react < plan < done
    assert "`scooter-github` skill" in text
    assert "don't wait for approval" in text


def test_without_a_comment_there_is_nothing_to_react_to():
    text = reply_workflow("gitlab_comment", "agent-tools", react=False)
    assert "React" not in text
    assert text.splitlines()[1].startswith("1. For more than a quick answer")


def test_names_no_endpoint():
    """Endpoints live in the skills, which change without a redeploy."""
    text = reply_workflow("github_comment", "scooter-github")
    assert "agent-broker" not in text
    assert "reactions" not in text
