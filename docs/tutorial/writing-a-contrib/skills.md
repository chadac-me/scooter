# Skills

A contrib documents itself to the agent. Its skill lives next to the code it describes,
and ships exactly when the contrib is enabled.

```nix
# contrib/acme/contrib.nix
config = {
  src = ./.;
  services.broker.enable = true;
  skills."scooter-acme.md" = ./skills/scooter-acme.md;
};
```

The key is the filename the agent sees. Name it `scooter-<contrib>.md`, so an operator
can tell where it came from and can replace it by setting the same name in
`scooter.agent.skills` (see [Customizing skills](../skills.md)).

## What to put in it

The skill is how the agent learns your integration exists, so cover:

1. **What it can do**, and that the credential is handled for it.
2. **How to call it**: the `agent-broker` path prefix, and a few real commands that work.
3. **The tools**, and when to prefer them over the raw API.
4. **What failures mean**, especially that a `404` on `/acme/` means "not enabled in this
   deployment", not "broken".

```markdown
---
name: scooter-acme
description: >-
  Reading and updating Acme Tracker issues through the broker. Use when a task
  mentions an Acme issue key (like ENG-42), an acme.example link, or the tracker.
---

# Acme Tracker (scooter-acme)

You can read and write Acme through the credential broker. You never see the token:
the broker adds it to each request.

## The API

`agent-broker acme/<path>` proxies to `https://api.acme.example/<path>`. The path
comes first; any curl arguments follow.

    agent-broker acme/v1/issues/ENG-42 | jq '{title, status}'
    agent-broker acme/v1/issues -X POST -H 'Content-Type: application/json' \
      -d '{"project": "ENG", "title": "…"}'

Issues you create this way are attached to the conversation automatically.

## Replying

To answer someone on an issue, use the `acme_comment` tool rather than the API. It
returns the real error if the post fails.

## Errors

- `404` on any `acme/` path: Acme isn't enabled here. Say so; don't retry.
- `401` or `403`: the deployment's token lacks access to that project.
```

Write the `description` for when the agent should load the skill, not what it contains.
Test it the way an agent would meet it: in a fresh conversation, ask for something that
should trigger it and watch whether it's used.

Next: [the webhook handler](webhooks.md).
