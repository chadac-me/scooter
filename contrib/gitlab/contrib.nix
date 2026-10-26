{ lib, ... }:
{
  contribs.gitlab = {
    options.forgePolicy = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "my_scooter_policies.gitlab:policy";
      description = ''
        A `module:attr` naming a ForgePolicy (scooter_broker_lib.forge) the broker
        checks on every GitLab request it makes for an agent: git push/fetch through
        the forge proxy, `glab`, the http-proxy and the agent tools. The module must be
        importable by the broker. Empty (the default) allows everything the token allows.
      '';
    };

    options.tokenSecret = lib.mkOption {
      type = lib.types.submodule {
        options = {
          name = lib.mkOption { type = lib.types.str; description = "Secret name (in the broker namespace)."; };
          key = lib.mkOption { type = lib.types.str; default = "GITLAB_TOKEN"; description = "Secret key holding the GitLab token."; };
        };
      };
      description = ''
        Secret holding the GitLab token (glpat-…). Injected as GITLAB_TOKEN. The
        secret must exist in the broker namespace.

        Enabling this contrib enables the GitLab provider: a transparent
        http-proxy to gitlab.com with the token injected.
      '';
    };

    config = {
      src = ./.;
      sandbox.module = ./sandbox.nix;

      # The UI row: the GitLab chip, icon and card.
      ui = {
        source = { label = "GitLab"; icon = ./icon.svg; color = "#FC6D26"; linkProvider = true; };
        tools.gitlab_comment = {
          argKey = "body";
          action = "commented on GitLab";
          titles = [ "Comment on the GitLab MR" ];
        };
      };
      services.broker.enable = true;
      services.webhooks = {
        enable = true;
        # Only this half reads Jira keys, and the grammar is jira's.
        pythonDeps = ps: [ ps.scooterContrib.jira ];
      };
    };
  };
}
