# What brave is, and the one option a deployment sets.
{ lib, ... }:
let
  clib = import ../lib.nix { inherit lib; };
in
{
  contribs.brave = { config, ... }: {
    options.apiKeySecret = clib.mkSecretOption {
      key = "BRAVE_SEARCH_API_KEY";
      holds = "the Brave subscription token";
      description = ''
        Secret holding a Brave Search subscription token (api-dashboard.search.brave.com).
        Injected as BRAVE_SEARCH_API_KEY; the broker delivers it upstream as an
        X-Subscription-Token HEADER, never a query param — a key in a URL is copied
        into every access log it passes. The secret must exist in the broker namespace.

        The key is what the provider gates its own `enabled` on, so a deployment that
        enables this contrib and forgets the secret gets a broker with no brave
        provider and an agent with no brave_web_search — never a tool that 401s.
      '';
    };

    config = {
      src = ./.;
      services.broker = {
        enable = true;
        env.BRAVE_SEARCH_API_KEY = config.apiKeySecret;
      };

      # No `ui` (the tool renders as a plain call and brave is not a linked-resource
      # source) and no `skills` (search guidance lives in skills/agent-tools.md and
      # what is brave-specific belongs in the tool's docstring).
    };
  };
}
