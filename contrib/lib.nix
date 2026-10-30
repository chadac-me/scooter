# Option helpers shared by the contribs' declarations.
{ lib }:

let
  inherit (lib) mkOption types;
in
rec {
  # A key in a Kubernetes Secret in the service's namespace.
  secretRef = { key, holds }: types.submodule {
    options = {
      name = mkOption { type = types.str; description = "Secret name (in the service's namespace)."; };
      key = mkOption { type = types.str; default = key; description = "Secret key holding ${holds}."; };
    };
  };

  # A Secret option; `nullable` makes it optional, defaulting to null.
  mkSecretOption = { key, holds, description, nullable ? false, example ? null }: mkOption ({
    type = (if nullable then types.nullOr else lib.id) (secretRef { inherit key holds; });
    inherit description;
  } // lib.optionalAttrs nullable { default = null; }
    // lib.optionalAttrs (example != null) { inherit example; });
}
