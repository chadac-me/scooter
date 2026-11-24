# One conversation hook, shared by scooter.agent.hooks and contribs.
{ lib }:

{ name, ... }:
let
  inherit (lib) mkOption types;
in
{
  options = {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = "Run this hook. Turning it off removes it for every user.";
    };

    event = mkOption {
      type = types.enum [ "SessionStart" "UserPromptSubmit" "PreToolUse" "PostToolUse" "Stop" ];
      description = ''
        When the hook runs. `Stop` fires each time the agent tries to end its turn, and a
        block sends it back to work with the hook's reason. `PreToolUse` can refuse or rewrite
        a tool call. Inputs and outputs follow Claude Code's hooks reference, plus a `scooter`
        object (conversation_id, owner, provider, run_id, source, folder, and stop_blocks on Stop).
      '';
    };

    matcher = mkOption {
      type = types.str;
      default = "";
      example = "Bash|Edit|Write";
      description = ''
        Anchored regex over the tool name (tool events) or the session source (SessionStart);
        empty matches everything. Claude sees sandbox tools by their built-in names (`Bash`,
        `Edit`); goose names them by title (`Shell`, `Read`).
      '';
    };

    command = mkOption {
      type = types.nullOr types.lines;
      default = null;
      example = lib.literalExpression "builtins.readFile ./check.sh";
      description = ''
        A bash script, run as `bash -c` in /workspace inside the sandbox with the event JSON
        on stdin. Exit 2 blocks, with stderr as the reason; exit 0 may print a JSON object
        (`decision`, `reason`, `hookSpecificOutput`, `systemMessage`, `continue`).
        Set exactly one of `command` and `broker`.
      '';
    };

    broker = mkOption {
      type = types.nullOr types.nonEmptyStr;
      default = null;
      example = "kanban/hooks/session-start";
      description = ''
        A broker path the agent-host POSTs the event JSON to, as the conversation, instead of
        running a script in the sandbox. A 2xx body is read as a script's stdout (the same
        JSON object); any other status is a failed hook. It needs no sandbox, so unlike a
        `command`, a `SessionStart` or `UserPromptSubmit` broker hook runs while the pod is
        still starting. Use it for a hook that only asks the broker something.
      '';
    };

    when = mkOption {
      type = types.nullOr (types.enum [ "untitled" "filed" ]);
      default = null;
      description = ''
        A precondition agent-host checks itself before running the hook, so other events
        cost no sandbox exec. `untitled`: the conversation has no title yet (Stop only).
        `filed`: the owner filed the conversation in one of their folders.
      '';
    };

    timeout = mkOption {
      type = types.ints.positive;
      default = 30;
      description = "Seconds before the hook is killed and treated as failed.";
    };

    failClosed = mkOption {
      type = types.bool;
      default = false;
      description = "Treat a crash or timeout as a block. Off means a broken hook is skipped.";
    };

    userCanDisable = mkOption {
      type = types.bool;
      default = false;
      description = "Users may turn this hook off for their own conversations in settings.";
    };

    description = mkOption {
      type = types.str;
      default = "";
      description = "One line shown next to the hook on the settings page.";
    };
  };
}
