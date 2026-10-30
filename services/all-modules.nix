# Every service's packages and image, for the platform eval.
# An explicit list, as in contrib/all-modules.nix.
{
  imports = [
    ./agent-host/module.nix
    ./broker/module.nix
    ./byoc-controller/module.nix
    ./claude-sdk-provider/module.nix
    ./conversation-controller/module.nix
    ./conversation-router/module.nix
    ./db-migrator/module.nix
    ./remote-agent/module.nix
    ./ui/module.nix
    ./scheduler/module.nix
    ./warm-store-controller/module.nix
    ./webhooks/module.nix
  ];
}
