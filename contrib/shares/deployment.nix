# shares' deployment half: option renames, legacy broker tables, ingress-derived env.
#
# `{ config, lib, ... }` only, and nothing built: an external deployer imports
# modules/platform.nix with no `pkgs`, so forcing a package here is an eval error.
{ config, lib, ... }:

let
  cfg = config.scooter;
  ccfg = config.contribs.shares;

  # Both fall back to the ingress host; with neither set the broker keeps its defaults.
  orIngress = v:
    if v != "" then v
    else if cfg.ingress.host != "" then "https://${cfg.ingress.host}"
    else "";
  publicBaseUrl = orIngress ccfg.publicBaseUrl;
  frameAncestors = orIngress ccfg.frameAncestors;
in
{
  imports = [
    (lib.mkRenamedOptionModule [ "scooter" "broker" "shares" "enable" ] [ "contribs" "shares" "enable" ])
    (lib.mkRenamedOptionModule [ "scooter" "broker" "shares" "publicBaseUrl" ] [ "contribs" "shares" "publicBaseUrl" ])
    (lib.mkRenamedOptionModule [ "scooter" "broker" "shares" "frameAncestors" ] [ "contribs" "shares" "frameAncestors" ])
  ];

  config = lib.mkMerge [
    # Gated on the contrib being BUILT, as contrib/files explains for its own row.
    # LEGACY: the tables now live in contrib_shares (contrib.nix `db`). The broker
    # copies stay declared until every deployment has set
    # scooter.dbMigrate.retireCopiedTables; then these rows and `copyFrom` go together.
    (lib.mkIf ccfg.enable {
      scooter.db.broker.tables = {
        static_shares = { writers = [ "broker" ]; };
        static_share_versions = { writers = [ "broker" ]; };
      };
    })

    # Rendered by modules/contrib-env.nix with the rest of the contrib env.
    {
      contribs.shares.services.broker.env = {
        SHARES_PUBLIC_BASE_URL = lib.mkIf (publicBaseUrl != "") publicBaseUrl;
        SHARES_FRAME_ANCESTORS = lib.mkIf (frameAncestors != "") frameAncestors;
      };
    }
  ];
}
