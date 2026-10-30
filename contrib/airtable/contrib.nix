{ lib, ... }:
let
  clib = import ../lib.nix { inherit lib; };
in
{
  contribs.airtable = { config, ... }: {
    options.tokenSecret = clib.mkSecretOption {
      key = "AIRTABLE_TOKEN";
      holds = "the Airtable personal access token";
      description = ''
        Secret holding an Airtable personal access token (pat…). Injected as
        AIRTABLE_TOKEN. The secret must exist in the broker namespace.

        Enabling this contrib runs the Airtable provider: an http-proxy to
        api.airtable.com with the token injected.
      '';
    };

    config = {
      src = ./.;
      services.broker = {
        enable = true;
        env.AIRTABLE_TOKEN = config.tokenSecret;
      };
      skills."scooter-airtable.md" = ./skills/scooter-airtable.md;
    };
  };
}
