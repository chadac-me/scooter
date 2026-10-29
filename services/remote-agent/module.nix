{ lib, buildPkgs, ... }:

{
  # Not in scooter.images: tagging it forces the unfree claude CLI.
  scooter.packages = {
    scooter-remote-agent = lib.mkDefault (buildPkgs.callPackage ./. { });
    # For `--backend echo`: no claude CLI, so pure eval works.
    scooter-remote-agent-echo = lib.mkDefault (buildPkgs.callPackage ./. { claude-code = null; });
  };
}
