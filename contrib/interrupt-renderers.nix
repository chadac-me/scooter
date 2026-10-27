# Resolves every enabled contrib's `ui.interruptRenderers` into the manifest's
# `interruptRenderers` section, keyed by request kind, and throws on a declaration
# the UI could not load. Lib-only, so examples/check.nix can drive it with fixtures.
{ lib }:

let
  resolveOne = name: c: kind: r:
    let
      where = "contribs.${name}.ui.interruptRenderers.\"${kind}\"";
      check = cond: msg: if cond then true else throw "${where}: ${msg}";
    in
    assert check (builtins.match "[a-z][a-z0-9-]*\\.[a-z][a-z0-9.-]*" kind != null)
      "the kind must look like \"<contrib>.<name>\" (lowercase, digits, '-' and '.')";
    assert check (lib.hasPrefix "${name}." kind)
      "the kind must start with \"${name}.\", so request kinds stay scoped to their contrib";
    assert check (builtins.match "ui/[^/]+\\.tsx" r.entry != null)
      "entry \"${r.entry}\" must be a .tsx file directly in the contrib's ui/ directory";
    assert check (builtins.pathExists (c.src + "/${r.entry}"))
      "entry \"${r.entry}\" does not exist in contrib/${name}/";
    lib.nameValuePair kind { contrib = name; entry = "${name}/${r.entry}"; };
in

# contribs: the enabled contribs, name -> config. The prefix rule makes kinds unique
# across contribs, since a contrib name contains no '.'.
contribs:
lib.listToAttrs (lib.concatLists (lib.mapAttrsToList
  (name: c: lib.mapAttrsToList (resolveOne name c) c.ui.interruptRenderers)
  (lib.filterAttrs (_: c: c.ui.enable) contribs)))
