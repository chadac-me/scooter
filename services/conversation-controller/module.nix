{ config, lib, buildPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages.scooter-conversation-controller = lib.mkDefault (buildPkgs.callPackage ./. { });

  scooter.images.conversation-controller = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = buildPkgs;
      inherit (cfg) n2c imageLayers;
      conversationController = buildPkgs.scooter-conversation-controller;
    });
    attr = "conversation-controller-image";
    refKey = "conversationController";
  };
}
