# duckduckgo's declaration; its deployment options are in ./deployment.nix.
{
  contribs.duckduckgo = {
    src = ./.;
    services.broker.enable = true;

    # No `ui` and no `skills`, for the reasons in contrib/brave/contrib.nix.
  };
}
