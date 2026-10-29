{ config, lib, ... }:

let
  cfg = config.scooter.config;
  inherit (cfg) pkgs;
in
{
  scooter.packages.scooter-conversation-controller = lib.mkDefault (pkgs.callPackage ./. { });

  scooter.images.conversation-controller = {
    package = lib.mkDefault (import ./image.nix {
      inherit pkgs;
      inherit (cfg) n2c imageLayers;
      conversationController = pkgs.scooter-conversation-controller;
    });
    attr = "conversation-controller-image";
    refKey = "conversationController";
  };
}
