# Resolves every enabled contrib's `agent.blockingTools` into the table the agent-host
# reads as BLOCKING_TOOLS_JSON (tool name -> { kind, title, dismissed }), throwing on a
# kind outside the contrib's namespace or a tool two contribs both claim.
{ lib }:

contribs:
let
  rows = lib.concatLists (lib.mapAttrsToList
    (name: c: lib.mapAttrsToList
      (tool: t:
        if !(lib.hasPrefix "${name}." t.kind)
        then throw "contribs.${name}.agent.blockingTools.${tool}: kind \"${t.kind}\" must start with \"${name}.\""
        else { inherit tool; contrib = name; value = { inherit (t) kind title dismissed; }; })
      c.agent.blockingTools)
    contribs);
  owners = lib.foldl' (acc: r: acc // { ${r.tool} = (acc.${r.tool} or [ ]) ++ [ r.contrib ]; }) { } rows;
  clashes = lib.filterAttrs (_: cs: lib.length cs > 1) owners;
in
if clashes != { } then
  throw ("contrib blocking tools: ${lib.concatStringsSep "; " (lib.mapAttrsToList
    (tool: cs: "${tool} is claimed by contribs ${lib.concatStringsSep " and " cs}") clashes)}")
else lib.listToAttrs (map (r: lib.nameValuePair r.tool r.value) rows)
