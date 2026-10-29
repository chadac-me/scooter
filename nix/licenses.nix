# Eval-only license closure of each shipped component.
{ flake ? builtins.getFlake (toString ../.), system ? builtins.currentSystem }:
let
  inherit (flake.inputs.nixpkgs) lib;
  pkgs = flake.inputs.nixpkgs.legacyPackages.${system};
  self = flake.packages.${system};

  # Image roots: the packages each image copies in.
  shell = [ pkgs.cacert pkgs.coreutils pkgs.bashInteractive ];
  components = {
    agent-host = [ self.agentHost self.agent pkgs.nodejs ] ++ shell;
    agent-host-claude = [ pkgs.claude-code ];
    ui = [ self.ui pkgs.nginx pkgs.bashInteractive pkgs.coreutils pkgs.gettext ];
    broker = [ self.broker self.broker-tools self.contribs-all pkgs.python3 pkgs.cacert ];
    webhooks = [ self.webhooks pkgs.python3 pkgs.cacert ];
    scheduler = [ self.scheduler self.scooter-prompt pkgs.python3 pkgs.cacert ];
    conversation-controller = [ self.conversation-controller pkgs.python3 pkgs.cacert ];
    conversation-router = [ self.conversation-router pkgs.cacert ];
    warm-store-controller = [ self.warm-store-controller pkgs.python3 pkgs.cacert ];
    byoc-controller = [ self.byoc-controller pkgs.nodejs pkgs.cacert ];
    db-migrator = [ pkgs.atlas pkgs.gnugrep pkgs.postgresql_16 ] ++ shell;
    remote-agent = [ self.remote-agent pkgs.nodejs pkgs.claude-code pkgs.git ] ++ shell;
    sandbox = [ self.forge-shim self.code-server-bin self.scooter-vscode-ahp self.scooter-prompt ];
    base = [ pkgs.glibc pkgs.stdenv.cc.cc.lib ];
  };

  # Skips nativeBuildInputs: build tools never ship.
  edges = p: lib.filter lib.isDerivation (lib.flatten (map (a: p.${a} or [ ])
    [ "buildInputs" "propagatedBuildInputs" "requiredPythonModules" ]));

  # Keyed by name: forcing drvPath fails on unfree packages.
  closure = roots: builtins.genericClosure {
    startSet = map (p: { key = p.name; pkg = p; }) roots;
    operator = { pkg, ... }: map (p: { key = p.name; pkg = p; }) (edges pkg);
  };

  # Compound licenses carry their own operator.
  spdx = l:
    if builtins.isString l then l
    else if l ? licenses then
      "(" + lib.concatMapStringsSep " ${l.operator or "AND"} " spdx l.licenses + ")"
    else l.spdxId or l.shortName or l.fullName or "unknown";

  # A meta.license list means all of them apply.
  expr = ls: if ls == [ ] then null else lib.concatMapStringsSep " AND " spdx ls;

  src = toString flake.outPath;
  selfNames = map (p: p.name) (lib.filter lib.isDerivation (lib.attrValues self));

  describe = { pkg, ... }: {
    name = pkg.pname or (builtins.parseDrvName pkg.name).name;
    version = pkg.version or (builtins.parseDrvName pkg.name).version;
    homepage = pkg.meta.homepage or null;
    license = expr (lib.toList (pkg.meta.license or [ ]));
    # Unlicensed in-repo packages are ours, under the MIT LICENSE.
    firstParty = !(pkg.meta ? license)
      && (lib.hasPrefix src (pkg.meta.position or "") || lib.elem pkg.name selfNames);
    python = pkg ? pythonModule && pkg.pname or "" != "python3";
  };
in
lib.mapAttrs (_: roots: map describe (closure roots)) components
