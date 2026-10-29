# Every first-party package, built in the platform eval.
# Built here so a deployment's config reaches the builds.
{ config, lib, ... }:

let
  inherit (lib) mkOption types literalExpression;
  cfg = config.scooter.config;

  # Every exported module re-sets the inputs; the last wins.
  lastWins = lib.mkOptionType {
    name = "flake-inputs";
    description = "flake inputs";
    merge = _: defs: (lib.last defs).value;
  };

  # fastmcp 3.4.x is marked broken against mcp>=2; pin mcp_1 until fastmcp supports it (PR #906).
  mcpOverlay = _: prev: {
    pythonPackagesExtensions = prev.pythonPackagesExtensions ++ [ (pf: _: { mcp = pf.mcp_1; }) ];
  };
in
{
  imports = [
    ../contrib/module.nix
    ../contrib/code-server/module.nix
    ../lib/py/scooter-broker-lib/module.nix
    ../lib/py/scooter-lib/module.nix
    ../lib/py/scooter-schema/module.nix
    ../lib/py/scooter-task/module.nix
    ../lib/py/scooter-webhooks-lib/module.nix
    ../lib/ts/scooter-schema/module.nix
    ../lib/ts/scooter-svcauth/module.nix
    ../pkgs/broker-tools/module.nix
    ../pkgs/forge-shim/module.nix
    ../pkgs/sandbox-os/module.nix
    ../pkgs/scooter-prompt/module.nix
    ../services/agent-host/module.nix
    ../services/broker/module.nix
    ../services/byoc-controller/module.nix
    ../services/claude-sdk-provider/module.nix
    ../services/conversation-controller/module.nix
    ../services/conversation-router/module.nix
    ../services/db-migrator/module.nix
    ../services/remote-agent/module.nix
    ../services/scheduler/module.nix
    ../services/warm-store-controller/module.nix
    ../services/webhooks/module.nix
    ../ui/module.nix
  ];

  options.scooter.packages = mkOption {
    type = types.lazyAttrsOf types.package;
    default = { };
    description = ''
      Every first-party package, by its `scooter-*` name. Each is also in
      `scooter.config.pkgs`, so one package's dependencies resolve to the
      others: setting `scooter.packages.scooter-lib = myFork;` rebuilds
      everything that uses it, images included.
    '';
  };

  options.scooter.config = mkOption {
    default = { };
    description = "What shapes `scooter.packages`: the package set they build from, and helpers.";
    type = types.submodule {
      options = {
        system = mkOption {
          type = types.str;
          default = "x86_64-linux";
          description = ''
            The system the packages and images are built for: the cluster's
            nodes, not the machine rendering the manifests. Published images
            are x86_64-linux.
          '';
        };

        inputs = mkOption {
          type = lastWins;
          internal = true;
          description = "Scooter's flake inputs: nixpkgs, nix2container, nix-stubs, uv-nix.";
        };

        pkgs = mkOption {
          type = types.raw;
          default = import cfg.inputs.nixpkgs {
            inherit (cfg) system;
            overlays = [ mcpOverlay (_: _: config.scooter.packages) ];
          };
          defaultText = literalExpression "Scooter's nixpkgs, with scooter.packages overlaid";
          description = ''
            The package set every package builds from. It has `scooter.packages`
            overlaid, so `callPackage` resolves them by name. To build on another
            nixpkgs, overlay `config.scooter.packages` onto it the same way.
          '';
        };

        n2c = mkOption {
          type = types.raw;
          default = cfg.inputs.nix2container.packages.${cfg.system}.nix2container;
          defaultText = literalExpression "nix2container for this system";
          internal = true;
          description = "The nix2container builder the images use.";
        };

        imageLayers = mkOption {
          type = types.raw;
          default = import ../pkgs/image-layers.nix { inherit lib; inherit (cfg) pkgs n2c; };
          defaultText = literalExpression "pkgs/image-layers.nix";
          internal = true;
          description = "Runtime layers the service images share.";
        };

        deploymentModules = mkOption {
          type = types.listOf types.raw;
          default = [ ../.github/deployment/config.nix ];
          defaultText = literalExpression "[ ./.github/deployment/config.nix ]";
          internal = true;
          description = "The contrib config the broker, webhooks and sandbox images are built with.";
        };

        mkScooterTask = mkOption {
          type = types.raw;
          readOnly = true;
          description = "Packages a Python system task; see nix/scooter-task.nix.";
        };

        contribBuild = mkOption {
          type = types.raw;
          readOnly = true;
          internal = true;
          description = "The contrib registry built from `deploymentModules`, bucketed by service.";
        };

        sandboxPkgs = mkOption {
          type = types.raw;
          defaultText = literalExpression "pkgs's nixpkgs with the nix-stubs overlay";
          description = "The package set the sandbox image builds from.";
        };

        stubOverlay = mkOption {
          type = types.raw;
          internal = true;
          description = "The nix-stubs overlay `sandboxPkgs` is built with.";
        };

        nixStubs = mkOption {
          type = types.raw;
          internal = true;
          description = "The nix-stubs source, binary and extra arguments the in-pod re-converge vendors.";
        };
      };
    };
  };
}
