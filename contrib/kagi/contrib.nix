# What kagi is; its deployment options are in ./deployment.nix.
{ lib, ... }:
{
  contribs.kagi = {
    options.apiKeySecret = lib.mkOption {
      type = lib.types.nullOr (lib.types.submodule {
        options = {
          name = lib.mkOption { type = lib.types.str; description = "Secret name (in the broker namespace)."; };
          key = lib.mkOption { type = lib.types.str; default = "KAGI_API_KEY"; description = "Secret key holding the Kagi API token."; };
        };
      });
      default = null;
      example = lib.literalExpression ''{ name = "kagi-search-key"; key = "KAGI_API_KEY"; }'';
      description = ''
        Secret holding a Kagi API token (kagi.com/settings?p=api). Injected as
        KAGI_API_KEY, and delivered upstream as `Authorization: Bot <token>` — Kagi's
        own scheme word, not Bearer. The secret must exist in the broker namespace.

        `null` (the default) mounts no Kagi provider, so the agent gets no
        `kagi_web_search` tool rather than one that 401s. This is the gate: shipping
        the contrib is `contribs.kagi.enable`, serving the provider is this key.

        Better human-facing ranking than brave, at $12/1k requests with no free tier
        and a paid Kagi account required — and an LLM reranking the results erases much
        of that difference, so prefer `brave` unless you already pay for Kagi.
        Combinable with `brave` and `duckduckgo`.
      '';
    };

    config = {
      src = ./.;
      services.broker.enable = true;

      # Shipped alongside brave and enableable with it, since each tool is named for
      # its provider and each provider mounts only when its own key is set.
      # No `ui` and no `skills`, as in contrib/brave/contrib.nix.
    };
  };
}
