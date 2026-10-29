{ config, lib, scooterPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages.scooter-conversation-controller = lib.mkDefault (scooterPkgs.callPackage ./. { });

  scooter.images.conversation-controller = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = scooterPkgs;
      inherit (cfg) n2c imageLayers;
      conversationController = scooterPkgs.scooter-conversation-controller;
    });
    attr = "conversation-controller-image";
    refKey = "conversationController";
  };
}
