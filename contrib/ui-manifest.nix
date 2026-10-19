# Generates the UI's contrib manifest: the metadata every enabled contrib
# contributes to the frontend, as one JSON document nginx serves at
# /contrib/manifest.json and the UI fetches at runtime, so a deployment can
# change its contrib set without recompiling the bundle. An icon is data here (a
# viewBox plus a single path read from the contrib's .svg), not a component.
{ lib, writeText }:

let
  resolveSettingsTabs = import ./settings-tabs.nix { inherit lib; };

  # A malformed SVG is an author error, so it throws at eval rather than rendering a broken glyph.
  iconData = name: file:
    let
      svg = builtins.readFile file;
      viewBox = builtins.match ''.*viewBox="([^"]+)".*'' svg;
      path = builtins.match ''.*<path[^>]*d="([^"]+)".*'' svg;
    in
    if viewBox == null || path == null
    then throw "contrib ${name}: ${toString file} must be an SVG with a viewBox and a single <path d=…> (see contrib/README.md)"
    else { viewBox = lib.head viewBox; path = lib.head path; };
in

contribs:

let
  withUi = lib.filterAttrs (_: c: c.ui.enable) contribs;
  sourced = lib.filterAttrs (_: c: c.ui.source != null) withUi;

  sources = lib.mapAttrs
    (name: c: {
      inherit (c.ui.source) label color linkProvider;
      icon = iconData name c.ui.source.icon;
    })
    sourced;

  # Keyed by the tool name the UI normalizes an incoming ACP tool call down to; `provider` selects the contrib's source row.
  toolCards = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList
    (name: c: lib.mapAttrsToList
      (tool: t: lib.nameValuePair tool { provider = name; inherit (t) argKey action; })
      c.ui.tools)
    withUi));

  # Lowercased: the UI matches a registerTool title case-insensitively.
  toolTitles = lib.listToAttrs (lib.concatLists (lib.mapAttrsToList
    (_: c: lib.concatLists (lib.mapAttrsToList
      (tool: t: map (title: lib.nameValuePair (lib.toLower title) tool) t.titles)
      c.ui.tools))
    withUi));

  linkProviders = lib.attrNames (lib.filterAttrs (_: c: c.ui.source.linkProvider) sourced);

  # Keyed by tab id; validated (and thrown on) in settings-tabs.nix.
  settingsTabs = resolveSettingsTabs contribs;

  # The presentation half of each contrib's approval gate, not gated on `ui.enable` because a contrib may raise approvals while contributing no icon.
  approvals = lib.mapAttrs
    (_: c: { inherit (c.approvals) gatedOption blockedTitle blockedHint; })
    (lib.filterAttrs (_: c: c.approvals != null) contribs);

  data = { inherit sources toolCards toolTitles linkProviders approvals settingsTabs; };
in
# `data` rides along so an eval (examples/check.nix) can read the manifest without a build.
writeText "contrib-manifest.json" (builtins.toJSON data) // { inherit data; }
