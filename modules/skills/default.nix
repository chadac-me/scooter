# Skill directories: agent skills that are a DIRECTORY (a SKILL.md with scripts/ and
# reference/ beside it, the shape `npx skills add` installs), as a platform feature.
#
#   skillDirs.marimo-pair = {
#     source = "github:marimo-team/marimo-pair";   # pinned in ./skills.lock
#     dir = "skills/marimo-pair";
#   };
#
# A deployment declares them here directly. A contrib is only a convenient way to
# add entries: `contribs.<name>.skillDirs` lands here when the contrib is enabled.
#
# The directory is split between the agent and the sandbox:
#   - the agent gets SKILL.md (modules/platform.nix ships it in the skills ConfigMap);
#   - the sandbox gets the whole directory at /etc/scooter/skills/<name>
#     (./sandbox.nix), where the agent's shell runs its scripts.
#
# A `source` names only the repo; its commit and narHash are pinned in ./skills.lock
# (`just lock-skills`), so the declaration stays lib-only. Lib-only, so the kubenix
# platform, the contrib registry and the image build all import it. The in-pod
# re-converge never evaluates this file: it has no network, and pinned or not,
# `fetchTree` still goes to the network (Why: PR #827). It reads the copies the
# image baked into the vendored tree instead
# (modules/sandbox-os/runtime-converge/reconverge-inputs.nix), with the same content
# and name, so the same store path, and a self-modify neither fetches nor churns /etc.
{ config, lib, ... }:

let
  inherit (lib) mkOption types literalExpression;

  enabledContribs = lib.filterAttrs (_: c: c.enable) (config.contribs or { });

  # Names are what the agent sees, so they are global, like tool names.
  fromContribs = lib.foldl'
    (acc: contrib: lib.foldl'
      (a: name:
        if a ? ${name} then
          throw "skill directory \"${name}\" is declared by both contribs.${a.${name}.contrib} and contribs.${contrib}."
        else a // { ${name} = { inherit contrib; spec = enabledContribs.${contrib}.skillDirs.${name}; }; })
      acc (lib.attrNames enabledContribs.${contrib}.skillDirs))
    { } (lib.attrNames enabledContribs);

  # One skill directory as a store path named for the skill, so the image and the
  # vendored copy in the pod (same content, same name) land on the same path.
  resolve = name: s:
    if builtins.match "[A-Za-z0-9][A-Za-z0-9._-]*" name == null then
      throw "skillDirs.\"${name}\": a skill name is a directory and file name, so only letters, digits, '.', '_' and '-'."
    else
    let
      entry = config.skillDirsLock.${name} or (throw ''
        skillDirs.${name}: no entry "${name}" in modules/skills/skills.lock.
        Run `just lock-skills` to pin it.'');
      root =
        if s.path != null && s.source == null then s.path
        else if s.source != null && s.path == null then
          if entry.source != s.source || entry.dir != s.dir then
            throw ''
              skillDirs.${name}: modules/skills/skills.lock pins
              ${entry.source} (dir "${entry.dir}"), but the declaration says
              ${s.source} (dir "${s.dir}"). Run `just lock-skills`.''
          else
            let tree = builtins.fetchTree {
              type = "github";
              inherit (entry) owner repo rev narHash;
            }; in
            if s.dir == "" then tree.outPath else "${tree.outPath}/${s.dir}"
        else throw "skillDirs.${name}: set exactly one of `path` or `source`.";
      src = builtins.path { path = root; name = "skill-${name}"; };
    in
    if !(builtins.pathExists "${src}/SKILL.md")
    then throw "skillDirs.${name}: ${if s.source != null then s.source else toString s.path} has no SKILL.md."
    else src;
in
{
  options = {
    skillDirs = mkOption {
      default = { };
      example = literalExpression ''
        {
          marimo-pair = {
            source = "github:marimo-team/marimo-pair";
            dir = "skills/marimo-pair";
          };
          my-skill.path = ./skills/my-skill;
        }
      '';
      description = ''
        Agent skills that are DIRECTORIES, keyed by the skill name the agent sees.
        The agent gets SKILL.md, with a note after its frontmatter naming
        /etc/scooter/skills/<name>, where the sandbox gets the whole directory.
        Set exactly one of `path` or `source` per entry. An enabled contrib's
        `contribs.<name>.skillDirs` are added here.
      '';
      type = types.attrsOf (types.submodule ./dir.nix);
    };

    skillDirsLock = mkOption {
      type = types.attrsOf types.attrs;
      default = lib.importJSON ./skills.lock;
      defaultText = literalExpression "lib.importJSON ./skills.lock";
      description = ''
        The pins for every `source` in `skillDirs` (written by `just lock-skills`).
        A deployment declaring sources this repo doesn't pin points this at its own lock.
      '';
    };

    resolvedSkillDirs = mkOption {
      type = types.attrsOf types.path;
      readOnly = true;
      internal = true;
      description = "`skillDirs` as store paths, the one place every consumer reads them from.";
    };
  };

  config = {
    skillDirs = lib.mapAttrs (_: d: lib.mkDefault d.spec) fromContribs;
    resolvedSkillDirs = lib.mapAttrs resolve config.skillDirs;
  };
}
