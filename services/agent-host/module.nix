{ config, lib, ... }:

let
  cfg = config.scooter.config;
  inherit (cfg) pkgs;
in
{
  scooter.packages = {
    # The ACP agent each conversation runs.
    scooter-agent = lib.mkDefault pkgs.goose-cli;
    scooter-agent-host = lib.mkDefault (pkgs.callPackage ./. { });
  };

  scooter.images.agent-host = { config, ... }: {
    options.claude.enable = lib.mkEnableOption "bake the unfree claude CLI into this image";

    config = {
      package = lib.mkDefault (import ./image.nix {
        inherit lib pkgs;
        inherit (cfg) n2c imageLayers;
        agentHost = pkgs.scooter-agent-host;
        agent = pkgs.scooter-agent;
        withClaudeCode = config.claude.enable;
      });
      attr = "agent-host-image";
      refKey = "agentHost";
    };
  };
}
