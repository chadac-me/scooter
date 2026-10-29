{ config, lib, ... }:

let
  inherit (config.scooter.config) pkgs;
in
{
  # Stubbed in the sandbox; built here so CI builds them.
  scooter.packages.scooter-vscode-ahp = lib.mkDefault (pkgs.callPackage ./ahp { });
  scooter.packages.scooter-code-server-bin = lib.mkDefault (pkgs.callPackage ./code-server-bin { });
}
