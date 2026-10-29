"""How the agent should answer a forge comment, appended to every forwarded one.

The commenter sees nothing until the agent posts something back, so the steps ask
for an emoji reaction first, then a plan comment before real work, then results.
Endpoints stay in the skills, which can change without a redeploy.
"""

from __future__ import annotations


def reply_workflow(comment_tool: str, skill: str, *, react: bool = True) -> str:
    """The react, plan, work, report steps; `react=False` when there is no comment to react to."""
    steps = []
    if react:
        steps.append(
            "**React with an emoji first** (👀 for \"seen, on it\") before reading code or "
            f"planning, using the id below; the `{skill}` skill has the call. It's one call and "
            "tells the commenter you have it."
        )
    steps.append(
        "**If it asks for more than a quick answer, comment your plan before doing the "
        f"work**, using `{comment_tool}`: what you understood, the approach, and any open "
        "questions. Then start on that plan right away; don't wait for approval. If they "
        "reply with corrections, adjust."
    )
    steps.append("**When finished, comment with the results.** A quick question only needs its answer.")
    numbered = "\n".join(f"{i}. {step}" for i, step in enumerate(steps, 1))
    return f"**How to respond (never work silently):**\n{numbered}"
