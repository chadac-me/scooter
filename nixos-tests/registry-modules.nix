# Pure eval (no VM) for registry-modules.nix, the shared-registry module fetch:
# with a file:// tarball of <id>/module.nix and an ids-list file it imports the
# attached ids' modules, and with no ids file it imports nothing.

{ pkgs, lib, sandboxModule ? null }:

let
  # A fixture tarball laid out as the broker's /modules.tar.gz?ids= returns it.
  fixture = pkgs.runCommand "registry-modules-fixture.tar.gz" { } ''
    mkdir -p m/alpha m/beta
    printf '%s' '{ ... }: { environment.etc."scooter-reg-alpha".text = "a"; }' > m/alpha/module.nix
    printf '%s' '{ ... }: { environment.etc."scooter-reg-beta".text = "b"; }' > m/beta/module.nix
    tar czf $out -C m .
  '';

  # The attached-ids file.
  idsFile = pkgs.writeText "registry-ids.json" (builtins.toJSON [ "alpha" "beta" ]);
in
pkgs.runCommand "dev-env-registry-modules"
  {
    nativeBuildInputs = [ pkgs.nix ];
  } ''
  export HOME=$TMPDIR
  export NIX_STORE_DIR=$TMPDIR/store
  export NIX_STATE_DIR=$TMPDIR/state

  # (1) With the ids file and tarball override, both attached modules are imported.
  imported=$(SCOOTER_REGISTRY_IDS_FILE="${idsFile}" SCOOTER_REGISTRY_URL="file://${fixture}" \
    nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
      let
        lib = (import ${pkgs.path} {}).lib;
        m = import ${../modules/sandbox-os/registry-modules.nix} { inherit lib; };
      in map (p: builtins.baseNameOf (builtins.dirOf p)) m.imports
    ')
  echo "imported ids: $imported"
  echo "$imported" | grep -q alpha || { echo "FAIL: alpha not imported"; exit 1; }
  echo "$imported" | grep -q beta  || { echo "FAIL: beta not imported"; exit 1; }

  # (2) With no ids file, nothing is imported.
  empty=$(SCOOTER_REGISTRY_IDS_FILE="$TMPDIR/none.json" SCOOTER_REGISTRY_URL="file://${fixture}" \
    nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
      let
        lib = (import ${pkgs.path} {}).lib;
        m = import ${../modules/sandbox-os/registry-modules.nix} { inherit lib; };
      in m.imports
    ')
  echo "empty-case imports: $empty"
  [ "$empty" = "[]" ] || { echo "FAIL: expected no imports with no ids file, got $empty"; exit 1; }

  echo "OK: registry-modules imports the attached ids, nothing when unattached"
  touch $out
''
