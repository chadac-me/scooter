# files' declaration: a sandbox-side viewer over the workspace, the broker-side
# store its review surface syncs to, and the skill that teaches the agent to open
# it for the user. Its deployment half is ./deployment.nix and its sandbox half
# ./sandbox.nix. `enable` stays opt-in like every other contrib; this repo's own
# builds turn it on in .github/deployment/config.nix.
{ lib, ... }:

{
  contribs.files = {
    options.annotations.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Mount the annotation store (PUT/GET /files/annotations/*) the viewer syncs
        a reviewer's comments and answers to, persisted in the shared `broker`
        database. Storing one prompts its conversation through the broker's
        `agentHostUrl`, so the agent wakes on a review remark.

        On by default: a viewer whose comments are not durable loses them with the
        sandbox, and the agent never hears them. Set false to ship the viewer as a
        read-only file browser — the routes are then ABSENT, which is the 404 the
        viewer reads as "not enabled here".
      '';
    };

    config = {
      src = ./.;

      # The broker half is the annotation store; the viewer itself runs in the
      # sandbox (./sandbox.nix) on the stdlib and is not packaged.
      services.broker = {
        enable = true;
        # The SQLite driver behind StoreConfig's local default, which is also what
        # the suite runs the store against (Postgres owns the deployed schema).
        pythonDeps = ps: [ ps.aiosqlite ];
      };

      sandbox.module = ./sandbox.nix;
      skills."scooter-files.md" = ./skills/scooter-files.md;
    };
  };
}
