{ lib, buildPkgs, ... }:

{
  # Stubbed in the sandbox; built here so CI builds them.
  scooter.packages.scooter-vscode-ahp = lib.mkDefault (buildPkgs.callPackage ./ahp { });
  scooter.packages.scooter-code-server-bin = lib.mkDefault (buildPkgs.callPackage ./code-server-bin { });
}
