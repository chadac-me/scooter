# A deployment that starts from Scooter's single-machine preset. Render with
# `nix build`, then `kubectl apply -f result` (docs: Run Scooter on your machine).
{
  inputs = {
    scooter.url = "github:chadac-me/scooter";
    flake-parts.follows = "scooter/flake-parts";
  };

  outputs = inputs@{ flake-parts, scooter, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      perSystem = { system, ... }: {
        packages.default =
          (scooter.lib.evalPlatform {
            inherit system;
            module = {
              imports = [ scooter.kubenixModules.local ./scooter.nix ];
              # Scooter's own agent skills.
              scooter.agent.skills = scooter.lib.scooterSkills;
            };
          }).config.kubernetes.result;
      };
    };
}
