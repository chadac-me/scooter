# Every shared library's package, for the platform eval.
# An explicit list, as in contrib/all-modules.nix.
{
  imports = [
    ./py/scooter-broker-lib/module.nix
    ./py/scooter-lib/module.nix
    ./py/scooter-schema/module.nix
    ./py/scooter-task/module.nix
    ./py/scooter-webhooks-lib/module.nix
    ./ts/scooter-schema/module.nix
    ./ts/scooter-svcauth/module.nix
  ];
}
