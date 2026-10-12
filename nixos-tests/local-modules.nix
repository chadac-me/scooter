# Pure eval (no VM) for local-modules.nix, the agent's own locally-authored
# modules: with SCOOTER_LOCAL_MODULES_DIR pointing at a fixture dir it imports every
# *.nix there, and with the dir absent it imports nothing.

{ pkgs, lib, sandboxModule ? null }:

let
  # Two agent-authored modules plus a non-.nix file that must be ignored.
  fixture = pkgs.runCommand "local-modules-fixture" { } ''
    mkdir -p $out
    printf '%s' '{ ... }: { environment.etc."scooter-local-alpha".text = "a"; }' > $out/alpha.nix
    printf '%s' '{ ... }: { environment.etc."scooter-local-beta".text = "b"; }' > $out/beta.nix
    printf '%s' 'not a nix module' > $out/README.md
  '';
in
pkgs.runCommand "dev-env-local-modules"
  {
    nativeBuildInputs = [ pkgs.nix ];
  } ''
  export HOME=$TMPDIR
  export NIX_STORE_DIR=$TMPDIR/store
  export NIX_STATE_DIR=$TMPDIR/state

  # (1) With the dir override, both *.nix are imported and the .md is ignored.
  imported=$(SCOOTER_LOCAL_MODULES_DIR="${fixture}" \
    nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
      let
        lib = (import ${pkgs.path} {}).lib;
        m = import ${../modules/sandbox-os/local-modules.nix} { inherit lib; };
      in map (p: builtins.baseNameOf p) m.imports
    ')
  echo "imported: $imported"
  echo "$imported" | grep -q alpha.nix || { echo "FAIL: alpha.nix not imported"; exit 1; }
  echo "$imported" | grep -q beta.nix  || { echo "FAIL: beta.nix not imported"; exit 1; }
  if echo "$imported" | grep -q README; then echo "FAIL: non-.nix README was imported"; exit 1; fi

  # (2) With the dir absent, nothing is imported.
  empty=$(SCOOTER_LOCAL_MODULES_DIR="$TMPDIR/does-not-exist" \
    nix eval --impure --offline --extra-experimental-features 'nix-command flakes' --json --expr '
      let
        lib = (import ${pkgs.path} {}).lib;
        m = import ${../modules/sandbox-os/local-modules.nix} { inherit lib; };
      in m.imports
    ')
  echo "empty-case imports: $empty"
  [ "$empty" = "[]" ] || { echo "FAIL: expected no imports for an absent dir, got $empty"; exit 1; }

  echo "OK: local-modules imports the agent's *.nix (ignoring non-nix), nothing when absent"
  touch $out
''
