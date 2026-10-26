{ lib, ... }:
{
  contribs.github = {
    options = {
      appId = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "GitHub App ID (GITHUB_APP_ID).";
      };

      installationId = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "GitHub App installation ID (GITHUB_APP_INSTALLATION_ID).";
      };

      forgePolicy = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "my_scooter_policies.github:policy";
        description = ''
          A `module:attr` naming a ForgePolicy (scooter_broker_lib.forge) the broker
          checks on every GitHub request it makes for an agent: git push/fetch through
          the forge proxy, `gh`, the http-proxy and the agent tools. The module must be
          importable by the broker. Empty (the default) allows everything the App allows.
        '';
      };

      privateKeySecret = lib.mkOption {
        type = lib.types.submodule {
          options = {
            name = lib.mkOption { type = lib.types.str; description = "Secret name (in the broker namespace)."; };
            key = lib.mkOption { type = lib.types.str; default = "private-key"; description = "Secret key holding the PEM."; };
          };
        };
        description = ''
          Secret holding the GitHub App private key (PEM). The secret must exist in
          the broker namespace.

          Enabling this contrib enables the GitHub provider, backed by a GitHub App:
          it vends installation tokens for git/HTTPS and the API.
        '';
      };
    };

    config = {
      src = ./.;
      sandbox.module = ./sandbox.nix;
      # The tool card the UI renders for github_comment.
      ui.tools.github_comment = { argKey = "body"; action = "commented on GitHub"; };

      # pyjwt+cryptography sign the RS256 App JWT that both halves mint.
      services.broker = {
        enable = true;
        pythonDeps = ps: [ ps.pyjwt ps.cryptography ];
      };
      services.webhooks = {
        enable = true;
        pythonDeps = ps: [ ps.pyjwt ps.cryptography ];
      };
    };
  };
}
