# The contribs' system tasks, built with mkScooterTask from each contrib's source.
# Shared by contrib/default.nix (the registry, whose tasks the scheduler image ships)
# and pkgs/scheduler-image/image.nix (the deployment's, which the ConfigMap names):
# the same inputs give the same store path, so the two agree.
{ lib, mkScooterTask }:

# contribs: the enabled contribs, name -> evaluated spec.
contribs:

lib.mapAttrs
  (name: c: lib.mapAttrs
    (id: t: {
      package = mkScooterTask {
        name = "${name}-${id}";
        inherit (t) entry pythonDeps;
        inherit (c) src;
      };
      inherit (t) args every cron timezone timeout model;
    })
    (lib.filterAttrs (_: t: t.enable) c.systemTasks))
  contribs
