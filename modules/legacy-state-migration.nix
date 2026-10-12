# One-time migration of legacy per-pod RWO conversation state (`state-agent-host-<n>`)
# into the shared history mirror (`agent-host-history`), as a one-shot Job that
# copies each legacy PVC's `conversations/` tree. Run it once during the cutover
# with agent-host scaled to 0, then turn the flag back off; a re-run only copies
# what is missing.

{ config, lib, ... }:

let
  cfg = config.scooter;
  mcfg = cfg.legacyStateMigration;
  ns = cfg.namespace;

  # Copy each conversation dir by glob (busybox `cp` lacks the GNU contents-copy
  # idiom), skipping any already on the mirror by testing existence first.
  copyScript = ''
    set -eu
    mkdir -p /mirror/conversations
    copied=0; skipped=0
    for src in ${lib.concatStringsSep " " (map (p: "/legacy/${p}") mcfg.legacyPvcs)}; do
      if [ ! -d "$src/conversations" ]; then
        echo ">> $src has no conversations/ dir — skipping"
        continue
      fi
      echo ">> $src/conversations: $(ls "$src/conversations" 2>/dev/null | wc -l) conversation(s)"
      for conv in "$src"/conversations/*; do
        [ -d "$conv" ] || continue
        name=$(basename "$conv")
        if [ -e "/mirror/conversations/$name" ]; then
          skipped=$((skipped + 1)) # already on the mirror
        else
          cp -a "$conv" /mirror/conversations/
          copied=$((copied + 1))
        fi
      done
    done
    echo ">> migration done. copied=$copied skipped=$skipped; mirror now has $(ls /mirror/conversations 2>/dev/null | wc -l) conversation(s)."
  '';
in
{
  options.scooter.legacyStateMigration = with lib; {
    enable = mkEnableOption ''
      the one-shot legacy-state migration Job (old per-pod RWO PVCs -> shared mirror). Turn ON for
      the cutover, run once (with agent-host scaled to 0), then turn OFF. See the module header'';
    legacyPvcs = mkOption {
      type = types.listOf types.str;
      default = [ "state-agent-host-0" "state-agent-host-1" ];
      example = [ "state-agent-host-0" "state-agent-host-1" "state-agent-host-2" ];
      description = ''
        The legacy StatefulSet per-pod RWO PVC names to migrate FROM (named
        `state-agent-host-<ordinal>` by the old volumeClaimTemplate). Each is mounted read-only
        and its `conversations/` tree copied into the mirror. List all that existed.
      '';
    };
    image = mkOption {
      type = types.str;
      default = "busybox:1.36";
      description = "A tiny image with a POSIX shell + cp (busybox) for the copy Job.";
    };
  };

  config = lib.mkIf mcfg.enable {
    kubernetes.resources.jobs.agent-legacy-state-migration = {
      metadata = { name = "agent-legacy-state-migration"; namespace = ns; };
      spec = {
        backoffLimit = 2;
        template.spec = {
          restartPolicy = "OnFailure";
          # fsGroup 0 so the copy can read the root-owned legacy PVCs.
          securityContext = { fsGroup = 0; fsGroupChangePolicy = "OnRootMismatch"; };
          containers.copy = {
            name = "copy";
            image = mcfg.image;
            command = [ "/bin/sh" "-c" copyScript ];
            volumeMounts =
              (map (p: { name = p; mountPath = "/legacy/${p}"; readOnly = true; }) mcfg.legacyPvcs)
              ++ [{ name = "mirror"; mountPath = "/mirror"; }];
          };
          volumes =
            (map (p: { name = p; persistentVolumeClaim = { claimName = p; readOnly = true; }; }) mcfg.legacyPvcs)
            ++ [{ name = "mirror"; persistentVolumeClaim.claimName = "agent-host-history"; }];
        };
      };
    };
  };
}
