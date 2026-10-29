# Conversation hooks

## Problem

Agents end turns with "Want me to open the PR?" even though the
`standing-authorization` skill tells them not to. A skill is a prompt, and the
model has to notice its own habit at the exact moment it is showing it. We need
a **mechanical** check that runs whenever the agent tries to stop and can send
it back to work.

More broadly, a deployment has no way to customize agent behaviour with code:
block `git push --force`, run the linter after every edit, inject context at
session start. Today each of these needs a change to Scooter's core.

## Design

Deployment-defined **hooks**: bash scripts the agent-host runs **in the
conversation's sandbox** at fixed points in a turn. The wire protocol is
**Claude Code's**: the same event names, matchers, JSON on stdin, and exit code
2 or a JSON object on stdout. So a hook written for Claude Code runs here, and
the other way round.

### Events

| Event | Fires | Can |
|---|---|---|
| `SessionStart` | first prompt of each agent session | add context |
| `UserPromptSubmit` | before a turn's prompt reaches the agent | refuse it, add context |
| `PreToolUse` | before a tool call (matcher on tool name) | deny with a reason, rewrite input |
| `PostToolUse` | after a tool call returns | send feedback to the model |
| `Stop` | the agent tries to end its turn | **block: the agent keeps going with the reason** |

Input is Claude Code's payload (`session_id`, `hook_event_name`, `cwd`,
`tool_name`, `tool_input`, `tool_response`, `stop_hook_active`,
`last_assistant_message`, …) plus a `scooter` object: `conversation_id`,
`owner`, `parent_id` (set for a subagent), `provider` (`goose` or `claude`),
`run_id`, `source`, and on Stop `stop_blocks`.

Output follows Claude Code: exit 2 blocks with stderr as the reason. Exit 0 may
print `decision`/`reason`, `hookSpecificOutput.{permissionDecision,
permissionDecisionReason, updatedInput, additionalContext}`, `continue: false`
and `systemMessage`. Any other exit is an error. An error is skipped (fails
open) unless the hook sets `failClosed`.

### Where it runs

- `services/agent-host/src/hooks/runner.ts` matches hooks, execs each as
  `bash -c` in `/workspace` with the JSON on stdin (`ExecRequest.stdin`, new),
  enforces the timeout and merges answers (any block wins, reasons join).
- **The bridge, for every backend**: `SessionStart` and `UserPromptSubmit`
  before the prompt, and `Stop` after it returns. A block sends the agent back
  **in the same run** with the reason as a hook system message. The user
  sees a "Hook" chip with the reason, then the agent's next reply.
- **Claude SDK**: `PreToolUse`/`PostToolUse` run inline in the SDK's own hooks,
  after the platform's tool policy. Sandbox tools are matched by built-in name
  (`Bash`, `Edit`).
- **Goose**: `PreToolUse` runs at goose's approve-mode tool gate. A refusal
  rejects the call, which ends goose's turn, and the bridge then delivers the
  reason. `PostToolUse` runs at the bridge, and its feedback is delivered the
  same way. Goose names tools by title (`Shell`, `Read`). It cannot rewrite
  input.
- BYOC remote agents get the bridge events only, since their tools run on the
  user's machine.

**Loop guard:** after `maxStopBlocks` (default 3) continuations in one turn the
agent may stop, with a chip saying so. A queued user message also ends the
continuation, since it is the next turn anyway.

**Visibility:** every run is logged by the `hooks` logger (hook, event,
decision, ms) and counted in `scooter_hook_runs_total{event,hook,decision}`.

### Configuration

- `scooter.agent.hooks.<id>` (Nix) and `contribs.<name>.agent.hooks.<id>`
  (ids `<name>.<id>`, only while the contrib is enabled). Options: `event`,
  `matcher`, `command`, `timeout`, `failClosed`, `userCanDisable`,
  `description`, `enable`. Rendered into `AGENT_HOOKS_JSON`.
- Users see the hooks on a **Settings → Hooks** tab and can turn off the ones
  marked `userCanDisable` (`agent_host.user_hook_settings`). Choices are read
  when a conversation's bridge is built.

### finish-or-ask (shipped, on by default, user-disableable)

`modules/hooks/finish-or-ask.sh` is a `Stop` hook. It blocks **once per turn**
(it passes when `stop_hook_active`) if:

- a repo under `/workspace` on a non-default branch has uncommitted changes,
  commits never pushed, unpushed commits, or (per `gh`) a pushed branch with
  no PR; or
- the reply's last line ends in a question. On Claude it says to use
  AskUserQuestion; on goose, to ask plainly.

The reason tells the agent it is pre-authorized to commit, push and open the
PR. It also gives an out: "if you are leaving it on purpose (waiting on the
user's review), say so in one line." Blocking once, not until the work is
clean, means a deliberate pause (such as a design review) costs one extra
line instead of a fight.

## Decisions

- **Config layers: deployment only** (Nix + contribs). User-authored and
  repo hooks are left for later. Users get on/off toggles for opt-out-able
  hooks.
- **Goose parity: full**, including a blocking `PreToolUse` via approve mode.
  Approve mode is turned on whenever a `PreToolUse` hook exists.
- **Hook types: `command` only** (runs in the sandbox). `http` and `prompt`
  hooks are not built.
- **finish-or-ask: on by default, user can disable.**

## Alternatives

- **Hooks in `.claude/settings.json` in the SDK's `cwd`.** The CLI would run
  them **on the agent-host**, a shared multi-tenant service, and only for
  Claude.
- **Python entry points in the broker/webhooks.** Users can't write them, and
  they can't see the sandbox's git state.
- **A Scooter-specific event schema.** It would mean rewriting every existing
  Claude Code hook.
- **More prompting.** Already tried; it's why this exists.

## Not built yet

`SubagentStop` (subagents are their own conversations, so they get `Stop`
with `scooter.parent_id` set; finish-or-ask skips them), `SessionEnd`, `http`/`prompt` hook
types, and user- or repo-authored hooks.
