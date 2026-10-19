# One skill directory's declaration: `skillDirs.<name>`, and the same shape under
# `contribs.<name>.skillDirs`. Lib-only, so every eval that declares skill
# directories (the platform, the contrib registry, the image build) shares it.
{ lib, ... }:

let
  inherit (lib) mkOption types literalExpression;
in
{
  options = {
    path = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = literalExpression "./skills/my-skill";
      description = "A skill directory in this repo.";
    };
    source = mkOption {
      type = types.nullOr (types.strMatching "github:[^/]+/[^/]+");
      default = null;
      example = "github:marimo-team/marimo-pair";
      description = ''
        The GitHub repo the skill comes from. The commit and hash are pinned in
        modules/skills/skills.lock, never here, so the declaration stays lib-only and
        the in-pod re-converge never fetches.
      '';
    };
    dir = mkOption {
      type = types.str;
      default = "";
      example = "skills/marimo-pair";
      description = "The skill's directory inside `source`; empty means the repo root.";
    };
  };
}
