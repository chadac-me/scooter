{ lib, ... }:
{
  contribs.jira = {
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
      description = ''
        Enable the Jira webhook handler (/webhooks/jira). Needs JIRA_WEBHOOK_SECRET
        in the webhooks provider Secret: without it every delivery gets a 401.
      '';
    };

    config = {
      src = ./.;
      services.broker.enable = true;
      services.webhooks.enable = true;

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
