{ lib, ... }:
let
  clib = import ../lib.nix { inherit lib; };
in
{
  contribs.gitlab = { config, ... }: {
    options.host = lib.mkOption {
      type = lib.types.str;
      default = "gitlab.com";
      example = "gitlab.example.com";
      description = ''
        The GitLab host: `gitlab.com`, or a self-hosted GitLab's hostname. The broker's
        forge proxy and http-proxy, the webhooks' API calls, and `glab` in the sandbox
        all target it.
      '';
    };

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

    options.webhooksEnabled = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Enable the GitLab webhook handler (/webhooks/gitlab). Set GITLAB_WEBHOOK_SECRET in the
        webhooks provider Secret: unset, deliveries are accepted unsigned.
      '';
    };

    options.tokenSecret = clib.mkSecretOption {
      key = "GITLAB_TOKEN";
      holds = "the GitLab token";
      description = ''
        Secret holding the GitLab token (glpat-…). Injected as GITLAB_TOKEN. The
        secret must exist in the broker namespace.

        Enabling this contrib enables the GitLab provider: a transparent
        http-proxy to gitlab.com with the token injected.
      '';
    };

    config = {
      src = ./.;
      links.typeAliases = lib.importJSON ./scooter_contrib_gitlab/link_type_aliases.json;
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
      services.broker = {
        enable = true;
        env = {
          GITLAB_HOST = config.host;
          GITLAB_TOKEN = config.tokenSecret;
          GITLAB_FORGE_POLICY = lib.mkIf (config.forgePolicy != "") config.forgePolicy;
        };
      };
      services.webhooks = {
        enable = true;
        env = {
          GITLAB_HOST = config.host;
          GITLAB_ENABLED = lib.boolToString config.webhooksEnabled;
        };
        # Only this half reads Jira keys, and the grammar is jira's.
        pythonDeps = ps: [ ps.scooterContrib.jira ];
      };
    };
  };
}
