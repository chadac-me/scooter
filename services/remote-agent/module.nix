{ config, lib, ... }:

let
  inherit (config.scooter.config) pkgs;
in
{
  # Not in scooter.images: tagging it forces the unfree claude CLI.
  scooter.packages = {
    scooter-remote-agent = lib.mkDefault (pkgs.callPackage ./. { });
    # For `--backend echo`: no claude CLI, so pure eval works.
    scooter-remote-agent-echo = lib.mkDefault (pkgs.callPackage ./. { claude-code = null; });
  };
}
