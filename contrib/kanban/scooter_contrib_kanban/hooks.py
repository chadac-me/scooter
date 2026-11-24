"""The kanban hooks' words, rendered from the card view `GET /card` returns.

These were jq templates in hooks/*.sh, run in the sandbox. The broker answers them now so the
agent-host can run the hooks while the sandbox is still starting.
"""

from __future__ import annotations

import json

STOP_REASON = (
    "This conversation is a card on a kanban board and its status wasn't set this run. "
    "Call kanban_set_status with the stage that fits the work now (the same stage confirms it) "
    "and a one-line note, then end your turn. Do not mention this to the user."
)


def _js(v: object) -> str:
    """jq's @json: a JSON string, non-ASCII kept."""
    return json.dumps(v, ensure_ascii=False)


def _quoted(names: list[str]) -> str:
    return ", ".join(f'"{n}"' for n in names)


def _blockers(card: dict) -> str:
    return ", ".join(f"{_js(b['title'])} ({b['stage']})" for b in card.get("blocked_by") or [])


def hook_context(event: str, text: str) -> dict:
    """Claude Code's output for a hook that only adds context; empty when there is none."""
    if not text:
        return {}
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}


def session_start_text(card: dict) -> str:
    """Tells an agent in a board folder that it is a card, and where."""
    column = card["column"]
    last = card["columns"][-1]
    out = (
        f'This conversation is a card on a kanban board, currently in the stage "{column}". '
        f"Stages: {_quoted(card['columns'])}. When the work changes phase, call kanban_set_status with the new stage "
        "and a one-line note on where things stand. The user may also move the card, or change the stages."
    )
    if card.get("blocked_by"):
        out += (
            f" It is blocked by {_blockers(card)}, so it can't move past this stage until they reach "
            f'"{last}"; you will be messaged when they do.'
        )
    if card.get("gates"):
        out += (
            f' To move on from "{column}" the card must pass: {"; ".join(g["line"] for g in card["gates"])}. '
            "Commands run on your last commit when you call kanban_set_status, so commit first; "
            "an approval asks the user, and you then end your turn until they answer."
        )
    if card.get("tags"):
        mine = _quoted(card.get("card_tags") or []) or "none"
        out += (
            f" Board tags: {_quoted(card['tags'])}; this card has {mine}. "
            "Tag it with kanban_set_tags once its kind of work is clear."
        )
    details = card.get("details") or {}
    if (details.get("priority") or "none") != "none":
        out += f" Priority: {details['priority']}."
    description = details.get("description") or ""
    if not description:
        out += " Once its scope is clear, describe the card with kanban_set_details."
    else:
        clipped = description[:500] + "..." if len(description) > 500 else description
        out += f" Its description: {_js(clipped)}."
    if card.get("skills"):
        names = ", ".join(f"`{s}`" for s in card["skills"])
        out += f" The user wrote skills for every card on this board: {names}. Read them before you start."
    return out


def prompt_submit_text(card: dict) -> str:
    """Reminds the agent of its card's stage with each message."""
    out = f'Kanban: this card is in "{card["column"]}"'
    c = card.get("card")
    if c is None:
        out += ", but no status has been set yet."
    elif c.get("updated_by") == "user":
        out += " (moved there by the user)."
    else:
        out += "."
    if c and c.get("note"):
        out += f" Note: {_js(c['note'])}."
    if card.get("blocked_by"):
        out += (
            f" Blocked by {_blockers(card)}: you can work in this stage, but can't move the card to a later one "
            f'until they reach "{card["columns"][-1]}".'
        )
    if card.get("gates"):
        out += f" To move on it must pass: {'; '.join(g['line'] for g in card['gates'])}."
    return out
