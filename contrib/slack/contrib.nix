{ lib, ... }:
let
  clib = import ../lib.nix { inherit lib; };
in
{
  contribs.slack = { config, ... }: {
    options.botTokenSecret = clib.mkSecretOption {
      key = "SLACK_BOT_TOKEN";
      holds = "the Slack bot token";
      description = ''
        Secret holding the Slack bot token (xoxb-…). Injected as SLACK_BOT_TOKEN. The
        secret must exist in the broker namespace.

        Enabling this contrib enables the Slack provider: an http-proxy to
        slack.com/api with the bot token injected.
      '';
    };

    config = {
      src = ./.;
      # The tool cards the UI renders for these calls, matched on the tool name.
      ui.tools = {
        slack_respond = { argKey = "text"; action = "replied in Slack"; };
        slack_react = { argKey = "emoji"; action = "reacted in Slack"; };
        get_slack_context = { argKey = ""; action = "read the Slack context"; };
      };
      services.broker = {
        enable = true;
        env.SLACK_BOT_TOKEN = config.botTokenSecret;
      };
      services.webhooks.enable = true;
      # How to format for Slack (mrkdwn, not Markdown).
      skills."slack-formatting.md" = ./skills/slack-formatting.md;
    };
  };
}
