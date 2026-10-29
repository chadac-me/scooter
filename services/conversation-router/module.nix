{ config, lib, scooterPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages.scooter-conversation-router = lib.mkDefault (scooterPkgs.callPackage ./. { });

  scooter.images.conversation-router = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = scooterPkgs;
      inherit (cfg) n2c;
      conversationRouter = scooterPkgs.scooter-conversation-router;
    });
    attr = "conversation-router-image";
    refKey = "conversationRouter";
  };
}
