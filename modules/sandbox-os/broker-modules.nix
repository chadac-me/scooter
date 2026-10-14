# Fetch and import the deployment's default NixOS modules from the broker, which
# serves them as one tarball of `<name>.nix` files at GET /modules/default.tar.gz.
# Impure by design (read during the in-pod `nix build --impure`) and fail-safe: no
# BROKER_URL, or an empty default set, imports nothing.

{ lib, ... }:

let
  # Empty means no fetch.
  brokerUrl = builtins.getEnv "BROKER_URL";

  # SCOOTER_DEFAULT_MODULES_URL overrides the URL verbatim (tests use a file:// fixture).
  urlOverride = builtins.getEnv "SCOOTER_DEFAULT_MODULES_URL";
  tarballUrl =
    if urlOverride != "" then urlOverride
    else if brokerUrl != "" then "${brokerUrl}/modules/default.tar.gz"
    else "";

  # Skipped when no source is configured.
  fetched =
    if tarballUrl != ""
    then builtins.fetchTarball { url = tarballUrl; }
    else null;

  # Every `.nix` file at the tarball root is a default module to import.
  modulePaths =
    if fetched == null then [ ]
    else
      let
        entries = builtins.readDir fetched;
        isNix = name: type: type == "regular" && lib.hasSuffix ".nix" name;
        names = builtins.filter (n: isNix n entries.${n}) (builtins.attrNames entries);
      in
      map (n: "${fetched}/${n}") names;
in
{
  imports = modulePaths;
}
