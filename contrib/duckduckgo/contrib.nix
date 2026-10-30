# duckduckgo's declaration. It has no key, so DUCKDUCKGO_ENABLED is its runtime gate.
{
  contribs.duckduckgo = {
    src = ./.;
    services.broker = {
      enable = true;
      env.DUCKDUCKGO_ENABLED = "true";
    };

    # No `ui` and no `skills`, for the reasons in contrib/brave/contrib.nix.
  };
}
