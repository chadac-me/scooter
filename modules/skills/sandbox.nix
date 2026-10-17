# The sandbox half of skill directories (./default.nix): each is installed whole at
# /etc/scooter/skills/<name>, where the agent's shell runs its scripts and reads its
# references. The image build sets `scooter.skillDirs` from the resolved
# declarations; the in-pod re-converge sets the same values from the copies baked
# into the vendored tree (skill-dirs/module.nix there), so a self-modify keeps them.
{ config, lib, ... }:

{
  options.scooter.skillDirs = lib.mkOption {
    type = lib.types.attrsOf lib.types.path;
    default = { };
    description = "Skill directories to install at /etc/scooter/skills/<name>.";
  };

  config.environment.etc = lib.mapAttrs'
    (name: src: lib.nameValuePair "scooter/skills/${name}" { source = src; })
    config.scooter.skillDirs;
}
