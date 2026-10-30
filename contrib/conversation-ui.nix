# Resolves enabled contribs' `ui.panel` and `ui.markdownFences` into the manifest's
# `panels` (keyed by contrib) and `markdownFences` (keyed by language) sections, and
# throws on a declaration the UI could not load. Lib-only, so examples/check.nix can
# drive it with fixtures.
{ lib }:

let
  checkEntry = where: name: c: entry:
    let check = cond: msg: if cond then true else throw "${where}: ${msg}"; in
    assert check (builtins.match "ui/[^/]+\\.tsx" entry != null)
      "entry \"${entry}\" must be a .tsx file directly in the contrib's ui/ directory";
    assert check (builtins.pathExists (c.src + "/${entry}"))
      "entry \"${entry}\" does not exist in contrib/${name}/";
    "${name}/${entry}";

  panelOf = name: c:
    let
      p = c.ui.panel;
      where = "contribs.${name}.ui.panel";
    in
    assert lib.assertMsg (!p.api || c.services.broker.enable)
      "${where}: api = true relays to this contrib's broker routes, so it needs services.broker.enable";
    {
      contrib = name;
      inherit (p) label order;
      entry = checkEntry where name c p.entry;
    };

  fencesOf = name: c: lib.mapAttrsToList
    (lang: f:
      let where = "contribs.${name}.ui.markdownFences.\"${lang}\""; in
      assert lib.assertMsg (builtins.match "[a-z][a-z0-9-]*" lang != null)
        "${where}: the language must match ^[a-z][a-z0-9-]*$";
      { inherit lang; value = { contrib = name; entry = checkEntry where name c f.entry; }; })
    c.ui.markdownFences;
in

# contribs: the enabled contribs, name -> config.
contribs:
let
  withUi = lib.filterAttrs (_: c: c.ui.enable) contribs;
  fences = lib.concatLists (lib.mapAttrsToList fencesOf withUi);
  owners = lib.foldl' (acc: f: acc // { ${f.lang} = (acc.${f.lang} or [ ]) ++ [ f.value.contrib ]; }) { } fences;
  clashes = lib.filterAttrs (_: cs: lib.length cs > 1) owners;
in
{
  panels = lib.mapAttrs panelOf (lib.filterAttrs (_: c: c.ui.panel != null) withUi);
  markdownFences =
    if clashes != { } then
      throw ("contribs' ui.markdownFences: ${lib.concatStringsSep "; " (lib.mapAttrsToList
        (l: cs: "\"${l}\" is claimed by contribs ${lib.concatStringsSep " and " cs}") clashes)}")
    else lib.listToAttrs (map (f: lib.nameValuePair f.lang f.value) fences);
}
