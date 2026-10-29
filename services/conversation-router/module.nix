{ config, lib, ... }:

let
  cfg = config.scooter.config;
  inherit (cfg) pkgs;
in
{
  scooter.packages.scooter-conversation-router = lib.mkDefault (pkgs.callPackage ./. { });

  scooter.images.conversation-router = {
    package = lib.mkDefault (import ./image.nix {
      inherit pkgs;
      inherit (cfg) n2c;
      conversationRouter = pkgs.scooter-conversation-router;
    });
    attr = "conversation-router-image";
    refKey = "conversationRouter";
  };
}
