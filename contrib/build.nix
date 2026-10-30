# The contribs' build half: one Python package per (contrib, service), as plain Nix
# over the evaluated spec so the lib-only schema (contrib/spec.nix) never needs a
# `pkgs`. A contrib build-depends on the extension surface libs only; the
# broker/webhooks apps are check-only inputs so its tests can drive the real services.
{ lib, python3Packages, broker, webhooks, scooterBrokerLib, scooterWebhooksLib }:

# contribs: the enabled contribs, name -> evaluated spec.
contribs:

let
  # Built once per service against only that service's surface.
  surfaces = {
    broker = { surface = scooterBrokerLib; entryModule = "broker_provider"; group = "agent_broker.providers"; };
    webhooks = { surface = scooterWebhooksLib; entryModule = "webhooks_handler"; group = "scooter_webhooks.handlers"; };
  };

  enabledServices = c: lib.filterAttrs (_: s: s.enable) c.services;

  # What pythonDeps receives: nixpkgs plus `scooterContrib.<name>` for the contribs
  # targeting this service, nested so a contrib cannot shadow a nixpkgs package.
  pkgsFor = svc: python3Packages // {
    scooterContrib = lib.mapAttrs (_: variants: variants.${svc})
      (lib.filterAttrs (_: variants: variants ? ${svc}) packages);
  };

  # tests/ is shared across variants, so every service's deps are check inputs for each one.
  checkDepsFor = c: svc: lib.concatMap (s: s.pythonDeps (pkgsFor svc))
    (lib.attrValues (enabledServices c));

  # Used when the contrib ships no pyproject.toml; Nix owns its deps either way.
  # Every enabled service's group, since tests/ exercises each one in every variant.
  defaultPyproject = name: c: builtins.toFile "pyproject.toml" (''
    [build-system]
    requires = ["hatchling"]
    build-backend = "hatchling.build"

    [project]
    name = "${c.distName}"
    version = "${c.version}"
    requires-python = ">=3.11"

    [tool.pytest.ini_options]
    asyncio_mode = "auto"
  '' + lib.concatStrings (lib.mapAttrsToList (svc: _: ''

    [project.entry-points."${surfaces.${svc}.group}"]
    ${name} = "${c.pyModule}.${surfaces.${svc}.entryModule}:${name}"
  '') (enabledServices c)));

  buildFor = name: c: svc:
    let s = surfaces.${svc}; in
    python3Packages.buildPythonPackage {
      # The distribution name, which the metadata-check hook looks the wheel up by.
      pname = c.distName;
      inherit (c) version src;
      pyproject = true;
      build-system = [ python3Packages.hatchling ];

      postPatch = lib.optionalString (!builtins.pathExists (c.src + "/pyproject.toml")) ''
        cp ${defaultPyproject name c} pyproject.toml
      '';

      dependencies = [ python3Packages.fastapi s.surface ]
        ++ c.services.${svc}.pythonDeps (pkgsFor svc);

      # A bad import fails here rather than at service startup.
      pythonImportsCheck = [ c.pyModule "${c.pyModule}.${s.entryModule}" ];

      nativeCheckInputs = (with python3Packages; [
        pytestCheckHook
        pytest-asyncio
        broker
        webhooks
      ]) ++ checkDepsFor c svc;

      meta.description = "Scooter contrib module: ${name} (${svc})";
    };

  # name -> service -> derivation, self-referential through pkgsFor so a contrib
  # may depend on another contrib's build.
  packages = lib.mapAttrs
    (name: c: lib.mapAttrs (svc: _: buildFor name c svc) (enabledServices c))
    contribs;
in
packages
