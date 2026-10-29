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
        object (conversation_id, owner, provider, run_id, source, and stop_blocks on Stop).
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
      type = types.lines;
      example = lib.literalExpression "builtins.readFile ./check.sh";
      description = ''
        A bash script, run as `bash -c` in /workspace inside the sandbox with the event JSON
        on stdin. Exit 2 blocks, with stderr as the reason; exit 0 may print a JSON object
        (`decision`, `reason`, `hookSpecificOutput`, `systemMessage`, `continue`).
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
