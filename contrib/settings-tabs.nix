# Resolves every enabled contrib's `ui.settingsTabs` into the manifest's
# `settingsTabs` section, keyed by tab id, and throws on a declaration the UI could
# not route. Lib-only and separate from ui-manifest.nix so examples/check.nix can
# drive the checks with fixture contribs.
{ lib }:

let
  # Must match SETTINGS_TABS in ui/src/view.ts. A contrib tab may not take one of
  # these URLs; this only bites a contrib whose name is a built-in id.
  builtinIds = [ "tasks" "skills" "claude" "modules" "admin" ];

  resolveOne = name: c: tab:
    let
      id = if tab.id == null then name else tab.id;
      where = "contribs.${name}.ui.settingsTabs (id \"${id}\")";
      check = cond: msg: if cond then true else throw "${where}: ${msg}";
    in
    assert check (builtins.match "[a-z][a-z0-9-]*" id != null)
      "the id must be a URL-safe slug matching ^[a-z][a-z0-9-]*$";
    assert check (id == name || lib.hasPrefix "${name}-" id)
      "the id must be \"${name}\" or start with \"${name}-\", so tab URLs stay scoped to their contrib";
    assert check (!(lib.elem id builtinIds))
      "\"${id}\" is a built-in settings tab (${lib.concatStringsSep ", " builtinIds})";
    assert check (builtins.match "ui/[^/]+\\.tsx" tab.entry != null)
      "entry \"${tab.entry}\" must be a .tsx file directly in the contrib's ui/ directory";
    assert check (builtins.pathExists (c.src + "/${tab.entry}"))
      "entry \"${tab.entry}\" does not exist in contrib/${name}/";
    assert check (!tab.api || c.services.broker.enable)
      "api = true relays to this contrib's broker routes, so it needs services.broker.enable";
    {
      inherit id;
      value = {
        contrib = name;
        inherit (tab) label order;
        entry = "${name}/${tab.entry}";
      };
    };

  resolveContrib = name: c:
    let
      tabs = map (resolveOne name c) c.ui.settingsTabs;
      ids = map (t: t.id) tabs;
      dupes = lib.unique (lib.filter (i: lib.count (x: x == i) ids > 1) ids);
    in
    if dupes != [ ] then
      throw ("contribs.${name}.ui.settingsTabs: duplicate tab id ${lib.concatMapStringsSep ", " (d: "\"${d}\"") dupes}."
        + " A tab's id defaults to the contrib name, so every tab but one needs an explicit `id = \"${name}-…\"`.")
    else tabs;
in

# contribs: the enabled contribs, name -> config.
contribs:
let
  all = lib.concatLists (lib.mapAttrsToList resolveContrib
    (lib.filterAttrs (_: c: c.ui.enable) contribs));
  # The prefix rule leaves one way to collide: contrib `aws` with a tab
  # `aws-accounts`, next to a contrib named `aws-accounts`.
  owners = lib.foldl' (acc: t: acc // { ${t.id} = (acc.${t.id} or [ ]) ++ [ t.value.contrib ]; }) { } all;
  clashes = lib.filterAttrs (_: cs: lib.length cs > 1) owners;
in
if clashes != { } then
  throw ("contrib settings tabs: ${lib.concatStringsSep "; " (lib.mapAttrsToList
    (id: cs: "id \"${id}\" is claimed by contribs ${lib.concatStringsSep " and " cs}") clashes)}")
else lib.listToAttrs (map (t: lib.nameValuePair t.id t.value) all)
