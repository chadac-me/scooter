# In-pod Nix configuration for the dev environment: flakes enabled, the per-user
# profile on PATH, and the `nixpkgs` flake registry pinned to a fixed nixpkgs so
# `nixpkgs#<pkg>` resolves deterministically. The dev-env-nix-build-skill nixosTest
# runs the nix-dev-env skill's documented commands against it.

{ config, lib, pkgs, ... }:

let
  cfg = config.devEnvNix;
in
{
  options.devEnvNix = {
    enable = lib.mkEnableOption "in-pod Nix for the agent (flakes, pinned registry, profile on PATH)";

    nixpkgs = lib.mkOption {
      type = lib.types.str;
      description = ''
        The nixpkgs the `nixpkgs` flake registry alias resolves to (a fixed ref,
        e.g. "github:NixOS/nixpkgs/<rev>"). Makes `nixpkgs#x` deterministic.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    nix.settings.experimental-features = [ "nix-command" "flakes" ];

    # Off, because these pods lack the user namespaces Nix's build sandbox needs.
    nix.settings.sandbox = false;

    # "" disables the global flake registry, so the pinned `nixpkgs` entry below is
    # the only source.
    nix.settings.flake-registry = "";

    # A path-flake ref (tests) pins to that store path; anything else is treated as
    # a github: ref.
    nix.registry.nixpkgs.to =
      if lib.hasPrefix "path:" cfg.nixpkgs
      then { type = "path"; path = lib.removePrefix "path:" cfg.nixpkgs; }
      else { type = "github"; owner = "NixOS"; repo = "nixpkgs"; };

    # Only reaches login shells; the non-login exec path inherits the container
    # image's Env.PATH (pkgs/sandbox-os), which prepends the profile bin itself.
    environment.sessionVariables.PATH = lib.mkAfter [ "$HOME/.nix-profile/bin" ];
  };
}
