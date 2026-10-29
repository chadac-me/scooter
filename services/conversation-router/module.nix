{ config, lib, buildPkgs, ... }:

let
  cfg = config.scooter.config;
in
{
  scooter.packages.scooter-conversation-router = lib.mkDefault (buildPkgs.callPackage ./. { });

  scooter.images.conversation-router = {
    package = lib.mkDefault (import ./image.nix {
      pkgs = buildPkgs;
      inherit (cfg) n2c;
      conversationRouter = buildPkgs.scooter-conversation-router;
    });
    attr = "conversation-router-image";
    refKey = "conversationRouter";
  };
}
