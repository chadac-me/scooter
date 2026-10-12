# echo's sandbox half: a plain NixOS module layered into the sandbox-os config at
# image build and replayed by every in-pod re-converge, kept as the fixture for the
# disabled-contrib path.
{ pkgs, ... }:

{
  environment.systemPackages = [
    (pkgs.writeShellScriptBin "echo-contrib-hello" ''
      echo "hello from the echo contrib"
    '')
  ];

  # The marker dev-env-contrib-sandbox asserts on.
  environment.etc."scooter/contrib-echo".text = "echo contrib sandbox module\n";
}
