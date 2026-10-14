# Fixture .scooter/ flake standing in for a deployment's injected tools dir,
# exposing one trivial package built with nixpkgs. The test rewrites the nixpkgs
# input to its own source so the in-VM build is offline.
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs";
  outputs = { self, nixpkgs }: {
    packages = builtins.listToAttrs (map
      (system: {
        name = system;
        value.injected-tool =
          nixpkgs.legacyPackages.${system}.writeShellScriptBin "injected-tool"
            "echo injected-tool-from-mounted-dir-ok";
      })
      [ "x86_64-linux" "aarch64-linux" ]);
  };
}
