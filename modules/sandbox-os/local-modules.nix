# Compose the agent's own NixOS modules into the re-converge: every `*.nix` under
# /etc/scooter/modules (a symlink onto the workspace PVC, see default.nix) is
# imported. Impure by design (read during the in-pod `nix build --impure`) and
# fail-safe: an absent or empty directory imports nothing, while a broken module
# fails the build gate.

{ lib, ... }:

let
  # The agent-editable modules dir; SCOOTER_LOCAL_MODULES_DIR is a test-only override.
  envDir = builtins.getEnv "SCOOTER_LOCAL_MODULES_DIR";
  dir = if envDir != "" then envDir else "/etc/scooter/modules";

  # Every `*.nix` file directly in the dir is a module to import.
  modulePaths =
    if builtins.pathExists dir
    then
      let
        entries = builtins.readDir dir;
        isNix = name: type: type == "regular" && lib.hasSuffix ".nix" name;
        names = builtins.filter (n: isNix n entries.${n}) (builtins.attrNames entries);
      in
      map (n: /. + "${dir}/${n}") names
    else [ ];
in
{
  imports = modulePaths;
}
