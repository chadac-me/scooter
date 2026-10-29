{ lib, buildNpmPackage, nodejs, scooter-schema-js ? null, ... }:

# The BYOC controller, which holds the bring-your-own-Claude container sockets so
# any agent-host replica can drive any container. `scooter-schema-js` (the generated
# @scooter/schema package) is copied rather than symlinked into node_modules so its
# drizzle-orm imports resolve to this package's own copy and share one type identity.
let
  appName = (lib.importJSON ./package.json).name;
in
buildNpmPackage {
  pname = "byoc-controller";
  version = "0.0.0";
  src = (import ../../nix/package-source.nix { inherit lib; }).of ./.;

  npmDepsHash = "sha256-GKXAfTgZu7zqI8pOBIX1osgZyaePqPx8i4NyYAhvxHs=";

  dontNpmBuild = false;
  npmBuildScript = "build";

  # Copy @scooter/schema's dist as a real dir before tsc, so its type imports resolve
  # to this package's drizzle-orm.
  postConfigure = lib.optionalString (scooter-schema-js != null) ''
    mkdir -p node_modules/@scooter/schema
    cp -rL ${scooter-schema-js}/lib/node_modules/@scooter/schema/dist node_modules/@scooter/schema/dist
    cp -L ${scooter-schema-js}/lib/node_modules/@scooter/schema/package.json node_modules/@scooter/schema/package.json
    chmod -R u+w node_modules/@scooter/schema
  '';

  # The runtime import must resolve from the installed app's own package dir, so
  # copy dist there too.
  postInstall = lib.optionalString (scooter-schema-js != null) ''
    appdir="$out/lib/node_modules/${appName}"
    if [ ! -d "$appdir/dist" ]; then
      echo "postInstall: expected app at $appdir (with dist/), not found — did package.json 'name' change?" >&2
      exit 1
    fi
    mkdir -p "$appdir/node_modules/@scooter/schema"
    cp -rL ${scooter-schema-js}/lib/node_modules/@scooter/schema/dist "$appdir/node_modules/@scooter/schema/dist"
    cp -L ${scooter-schema-js}/lib/node_modules/@scooter/schema/package.json "$appdir/node_modules/@scooter/schema/package.json"
    chmod -R u+w "$appdir/node_modules/@scooter/schema"
  '';

  meta = {
    description = "BYOC controller: owns the user's Claude container socket; agent-hosts drive it over HTTP/SSE";
    mainProgram = "byoc-controller";
  };
}
