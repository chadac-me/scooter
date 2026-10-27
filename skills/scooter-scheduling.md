---
name: scooter-scheduling
type: knowledge
version: 1.2.0
triggers:
- schedule a task
- scheduled task
- recurring
- every day
- every morning
- every weekday
- run this daily
- run this weekly
- cron
- remind me to
- check in periodically
- do this on a schedule
- automate this
- run automatically
- list my scheduled tasks
- cancel a scheduled task
---

# Scheduling recurring work (scheduled tasks)

You can **schedule yourself to run again later, on a repeating cron schedule.**
Each time a scheduled task fires, Scooter spawns a **fresh conversation** with the
task's `prompt` as the user message and runs it start-to-finish, or sends the
prompt to an existing conversation you chose. Use this whenever
the user wants something done *repeatedly* or *later* without them asking each time:
"every weekday at 9am, check the CI dashboard and post a summary to Slack", "every
Monday, open a PR bumping dependencies", "at the end of each day, write a standup
note".

These are **MCP tools** — prefer them over trying to hand-roll cron in the sandbox
(a `crontab` in the pod dies on suspend; scheduled tasks are durable and run on the
platform). Match the tool to your live tool list by purpose:

- **Create a scheduled task** — give it a short `title`, the `prompt` to run each
  time, and a `cron` schedule (+ optional `timezone`). It's owned by you.
  Pass `conversation_id` to send the prompt to an existing conversation instead
  (see below).
- **List scheduled tasks** / **Search scheduled tasks** — see what you already have
  (search matches the title or prompt).
- **View a scheduled task** — one task in detail, including its recent run history.
- **Edit a scheduled task** — change the title, prompt, cron, timezone, or turn it
  on/off (`enabled`). Prefer disabling over deleting when the user just wants a pause.
- **Delete a scheduled task** — permanent; only when the user clearly wants it gone.

## The cron field

`cron` is a standard **5-field** expression: `minute hour day-of-month month
day-of-week`. Examples:

| Schedule | cron |
|----------|------|
| 9:00 every weekday | `0 9 * * 1-5` |
| Every day at 07:30 | `30 7 * * *` |
| Every Monday at 08:00 | `0 8 * * 1` |
| Top of every hour | `0 * * * *` |
| 1st of the month, 06:00 | `0 6 1 * *` |

`timezone` is an IANA name (default **UTC**) — e.g. `America/New_York`. If the user
says "9am" they almost always mean *their* timezone; ask or pass the one you know
rather than silently scheduling in UTC.

## Prompting an existing conversation

By default every run starts a new conversation. To have each run continue an
*existing* one instead (a long-running project thread, a daily check-in that should
remember yesterday), pass `conversation_id`: `"this"` for the current conversation,
or the id of another conversation the user owns.

- The prompt arrives as a system message from the scheduler, not as the user.
- If the conversation is mid-run the prompt queues behind it; if it is suspended it
  is woken up.
- If the conversation is deleted, the task disables itself.
- The target is fixed at creation: to point a task elsewhere (or back to new
  conversations), delete it and create a new one.

## Writing the prompt

Unless it targets a conversation, each run is a **brand-new conversation** with no
memory of this one, so the `prompt` is all the future run gets. So write it to be **self-contained**: state the goal,
where to look, and what to do with the result (e.g. which Slack thread / PR to post
to). Don't write "do that thing we discussed"; spell it out.

Good: *"Check the failing tests on the `main` branch of acme/api (via the broker
GitHub proxy). If any are failing, post a short summary to Slack channel C0123."*

## Good practice

- **Confirm before creating.** Read the schedule back to the user ("I'll run this
  every weekday at 9am America/New_York — ok?") before creating it, especially for
  anything that posts externally.
- **One task per intent.** If the user changes the timing, *edit* the existing task
  rather than creating a second one — then list to confirm there's no duplicate.
- **Clean up.** Offer to delete or disable a task once its purpose is done.

If you don't see scheduling tools in your tool list, this deployment has no
scheduler — say so rather than faking a cron in the sandbox.
