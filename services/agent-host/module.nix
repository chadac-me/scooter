{ config, lib, scooterPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages = {
    # The ACP agent each conversation runs.
    scooter-agent = lib.mkDefault scooterPkgs.goose-cli;
    scooter-agent-host = lib.mkDefault (scooterPkgs.callPackage ./. { });
  };

  scooter.images.agent-host = { config, ... }: {
    options.claude.enable = lib.mkEnableOption "bake the unfree claude CLI into this image";

    config = {
      package = lib.mkDefault (import ./image.nix {
        inherit lib;
        pkgs = scooterPkgs;
        inherit (cfg) n2c imageLayers;
        agentHost = scooterPkgs.scooter-agent-host;
        agent = scooterPkgs.scooter-agent;
        withClaudeCode = config.claude.enable;
      });
      attr = "agent-host-image";
      refKey = "agentHost";
    };
  };
}
