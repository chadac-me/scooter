# Every first-party tool's package, for the platform eval.
# An explicit list, as in contrib/all-modules.nix.
{
  imports = [
    ./broker-tools/module.nix
    ./forge-shim/module.nix
    ./sandbox-os/module.nix
    ./scooter-prompt/module.nix
  ];
}
