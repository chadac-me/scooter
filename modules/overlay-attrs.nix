# Expands name-keyed `<list>Attrs` mappings in a Sandbox manifest overlay into the k8s lists
# they stand for, so the rendered overlay only ever holds plain lists.
{ lib }:
let
  # The lists that take an `Attrs` form, by where each item keeps its name.
  keyedLists = {
    containers = "name";
    initContainers = "name";
    volumes = "name";
    volumeMounts = "name";
    env = "name";
    ports = "name";
    volumeClaimTemplates = "metadata.name";
  };

  attrsKey = k: lib.hasSuffix "Attrs" k && keyedLists ? ${lib.removeSuffix "Attrs" k};

  toItem = list: path: name: v:
    if keyedLists.${list} == "metadata.name" && lib.isAttrs v
    then v // { metadata = (v.metadata or { }) // { inherit name; }; }
    else if lib.isAttrs v then v // { inherit name; }
    # A bare value is env's `value`, so `envAttrs.FOO = "x"` reads naturally.
    else if list == "env" then { inherit name; value = v; }
    else throw "${path}.${list}Attrs.${name} must be an attribute set";

  expandAt = path: v:
    if lib.isList v then map (expandAt path) v
    else if !lib.isAttrs v then v
    else
      let
        plain = lib.filterAttrs (k: _: !attrsKey k) v;
        fromAttrs = lib.mapAttrs' (k: m:
          let list = lib.removeSuffix "Attrs" k; in
          lib.nameValuePair list ((plain.${list} or [ ]) ++ lib.mapAttrsToList (toItem list path) m))
          (lib.filterAttrs (k: _: attrsKey k) v);
      in
      lib.mapAttrs (k: expandAt "${path}.${k}") (plain // fromAttrs);
in
{
  inherit keyedLists;
  expand = expandAt "sandboxManifestOverlay";
}
