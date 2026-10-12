# Pure eval (no VM) for broker-modules.nix, the deployment-default module import:
# with SCOOTER_DEFAULT_MODULES_URL pointing at a file:// tarball of two `<name>.nix`
# files it imports both, and with no url configured it imports nothing.

{ pkgs, lib, sandboxModule ? null }:

let
  # A fixture tarball with two default modules at its root.
  fixture = pkgs.runCommand "broker-modules-fixture.tar.gz" { } ''
    mkdir m
    printf '%s' '{ ... }: { environment.etc."scooter-default-alpha".text = "a"; }' > m/alpha.nix
    printf '%s' '{ ... }: { environment.etc."scooter-default-beta".text = "b"; }' > m/beta.nix
    tar czf $out -C m .
  '';
in
pkgs.runCommand "dev-env-broker-modules"
  {
    nativeBuildInputs = [ pkgs.nix ];
  } ''
  export HOME=$TMPDIR
  export NIX_STORE_DIR=$TMPDIR/store
  export NIX_STATE_DIR=$TMPDIR/state

  # (1) With the URL override, both default modules are imported.
  imported=$(SCOOTER_DEFAULT_MODULES_URL="file://${fixture}" \
    nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
      let
        lib = (import ${pkgs.path} {}).lib;
        m = import ${../modules/sandbox-os/broker-modules.nix} { inherit lib; };
      in map (p: builtins.baseNameOf p) m.imports
    ')
  echo "imported: $imported"
  echo "$imported" | grep -q alpha.nix || { echo "FAIL: alpha.nix not imported"; exit 1; }
  echo "$imported" | grep -q beta.nix  || { echo "FAIL: beta.nix not imported"; exit 1; }

  # (2) With no BROKER_URL and no override, nothing is imported.
  empty=$(env -u BROKER_URL -u SCOOTER_DEFAULT_MODULES_URL \
    nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
      let
        lib = (import ${pkgs.path} {}).lib;
        m = import ${../modules/sandbox-os/broker-modules.nix} { inherit lib; };
      in m.imports
    ')
  echo "empty-case imports: $empty"
  [ "$empty" = "[]" ] || { echo "FAIL: expected no imports with no broker url, got $empty"; exit 1; }

  echo "OK: broker-modules imports the default modules, and imports nothing when unconfigured"
  touch $out
''
