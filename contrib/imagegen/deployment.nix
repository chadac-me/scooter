# imagegen's deployment half, reading contribs.imagegen.
#
# `{ config, lib, ... }` only, and nothing built: an external deployer imports
# modules/platform.nix with no `pkgs`, so forcing a package here is an eval error.
{ config, lib, ... }:

let
  ccfg = config.contribs.imagegen;
  # The Bedrock backend's own freeform fields (region, roleArn); absent entirely
  # when the deployment never declared `backends.bedrock`.
  bedrock = ccfg.backends.bedrock or null;
in
{
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable && bedrock != null && bedrock.enable) {
    # IRSA: the broker pod calls bedrock-runtime as itself, no secret of ours to hold.
    scooter.broker.serviceAccountAnnotations = lib.optionalAttrs ((bedrock.roleArn or "") != "") {
      "eks.amazonaws.com/role-arn" = bedrock.roleArn;
    };
  };
}
