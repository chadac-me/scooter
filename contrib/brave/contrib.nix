# What brave is; its deployment options are in ./deployment.nix.
{ lib, ... }:
let
  inherit (lib) mkOption types;
in
{
  contribs.brave = {
    options.apiKeySecret = mkOption {
      type = types.submodule {
        options = {
          name = mkOption { type = types.str; description = "Secret name (in the broker namespace)."; };
          key = mkOption { type = types.str; default = "BRAVE_SEARCH_API_KEY"; description = "Secret key holding the Brave subscription token."; };
        };
      };
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
      services.broker.enable = true;

      # No `ui` (the tool renders as a plain call and brave is not a linked-resource
      # source) and no `skills` (search guidance lives in skills/agent-tools.md and
      # what is brave-specific belongs in the tool's docstring).
    };
  };
}
