{ lib, ... }:
{
  contribs.jira = { config, ... }: {
    options.siteUrl = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "https://acme.atlassian.net";
      description = ''
        The Jira SITE base URL, used to build a human /browse/{KEY} link when the
        broker auto-links an issue an agent creates via the Jira proxy (the
        create-issue API response carries no human URL). Empty -> auto-link uses
        the API `self` URL instead.
      '';
    };

    options.webhooksEnabled = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Enable webhooks.";
    };

    config = {
      src = ./.;
      links.typeAliases = lib.importJSON ./scooter_contrib_jira/link_type_aliases.json;
      services.broker = {
        enable = true;
        env.JIRA_SITE_URL = lib.mkIf (config.siteUrl != "") config.siteUrl;
      };
      services.webhooks = {
        enable = true;
        env.JIRA_ENABLED = lib.boolToString config.webhooksEnabled;
      };

      # The UI row: the Jira chip, icon and card.
      ui = {
        source = { label = "Jira"; icon = ./icon.svg; color = "#0052CC"; linkProvider = true; };
        tools.jira_comment = {
          argKey = "body";
          action = "commented on Jira";
          titles = [ "Comment on the Jira issue" ];
        };
      };
    };
  };
}
