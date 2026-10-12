# Fetch and import a conversation's attached registry modules from the broker.
# The attached ids live in /etc/scooter/registry-modules.json (managed by
# scooter-rebuild); the broker serves them as one tarball of <id>/module.nix at
# GET /modules.tar.gz?ids=a,b. Impure by design (read during the in-pod
# `nix build --impure`), and fail-safe: no ids or no BROKER_URL imports nothing,
# while a corrupt id list aborts the switch.

{ lib, ... }:

let
  # The attached-ids file; SCOOTER_REGISTRY_IDS_FILE is a test-only override.
  idsFileOverride = builtins.getEnv "SCOOTER_REGISTRY_IDS_FILE";
  idsFile = if idsFileOverride != "" then idsFileOverride else "/etc/scooter/registry-modules.json";

  # The attached ids: absent means none, corrupt means fromJSON throws.
  ids =
    if builtins.pathExists idsFile
    then builtins.fromJSON (builtins.readFile idsFile)
    else [ ];

  # SCOOTER_REGISTRY_URL overrides the whole URL (tests use a file:// fixture);
  # otherwise it is derived from BROKER_URL and the ids.
  brokerUrl = builtins.getEnv "BROKER_URL";
  urlOverride = builtins.getEnv "SCOOTER_REGISTRY_URL";
  tarballUrl =
    if urlOverride != "" then urlOverride
    else if brokerUrl != "" then "${brokerUrl}/modules.tar.gz?ids=${lib.concatStringsSep "," ids}"
    else "";

  # Skipped when nothing is attached or no source is configured.
  fetched =
    if tarballUrl != "" && ids != [ ]
    then builtins.fetchTarball { url = tarballUrl; }
    else null;

  # Each attached id's module.nix as a store-path string, which the module system
  # imports directly.
  modulePaths =
    if fetched == null then [ ]
    else map (id: "${fetched}/${id}/module.nix") ids;
in
{
  imports = modulePaths;
}
