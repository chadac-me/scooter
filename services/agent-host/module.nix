{ config, lib, buildPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages = {
    # The ACP agent each conversation runs.
    scooter-agent = lib.mkDefault buildPkgs.goose-cli;
    scooter-agent-host = lib.mkDefault (buildPkgs.callPackage ./. { });
  };

  scooter.images.agent-host = { config, ... }: {
    options.claude.enable = lib.mkEnableOption "bake the unfree claude CLI into this image";

    config = {
      package = lib.mkDefault (import ./image.nix {
        inherit lib;
        pkgs = buildPkgs;
        inherit (cfg) n2c imageLayers;
        agentHost = buildPkgs.scooter-agent-host;
        agent = buildPkgs.scooter-agent;
        withClaudeCode = config.claude.enable;
      });
      attr = "agent-host-image";
      refKey = "agentHost";
    };
  };
}
