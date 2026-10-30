"""How the agent should answer a forge comment, appended to every forwarded one.

The commenter sees nothing until the agent posts back, so: react, plan, report.
Endpoints stay in the skills, which can change without a redeploy.
"""

from __future__ import annotations


def reply_workflow(comment_tool: str, skill: str, *, react: bool = True) -> str:
    """The reply steps; `react=False` when there is no comment to react to."""
    steps = [f"React 👀 first, before anything else (see the `{skill}` skill)."] if react else []
    steps.append(f"For more than a quick answer, comment your plan with `{comment_tool}`, then start; don't wait for approval.")
    steps.append("When done, comment with the results.")
    numbered = "\n".join(f"{i}. {step}" for i, step in enumerate(steps, 1))
    return f"**How to respond:**\n{numbered}"
