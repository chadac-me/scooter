# The sandbox's systemd journal, bind-mounted onto the workspace PVC so it survives
# a container restart. The journal is the only record of what systemd did, since
# PID 1 logs nothing to stdio. The bind happens in the activation script, before
# systemd starts, so journald writes to the PVC from its first record; read a
# retained boot with `journalctl -D <path>`.

{ config, lib, pkgs, ... }:

let
  cfg = config.services.scooterJournalPersist;
in
{
  options.services.scooterJournalPersist = {
    enable = lib.mkEnableOption "the PVC-backed systemd journal";

    path = lib.mkOption {
      type = lib.types.str;
      default = "/workspace/.scooter/journal";
      description = ''
        Where the journal is kept. Must be on a filesystem the kubelet has mounted
        BEFORE the container's PID 1 runs (the workspace PVC is; the scooter-rw
        store PVC is not -- it is assembled by a systemd unit).
      '';
    };

    maxUse = lib.mkOption {
      type = lib.types.str;
      default = "64M";
      description = "SystemMaxUse: cap, so system logs cannot fill the agent's workspace.";
    };

    keepBoots = lib.mkOption {
      type = lib.types.int;
      default = 3;
      description = ''
        How many prior boots' journal directories to retain. /etc/machine-id is
        regenerated on every container start, so each boot adds a machine-id
        directory; journald's own vacuuming only manages its current one.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # persistent, not auto, so the first record reaches disk before any flush.
    services.journald.settings.Journal = {
      Storage = "persistent";
      SystemMaxUse = cfg.maxUse;
    };

    system.activationScripts.scooterJournalPersist = {
      deps = [ "specialfs" ];
      text = ''
        set -u
        jdir="${cfg.path}"
        pvc="$(dirname "$(dirname "$jdir")")"

        # Report rather than fail the boot, and skip when already bound since
        # activation re-runs on every `scooter-rebuild switch`.
        if ${pkgs.util-linux}/bin/mountpoint -q /var/log/journal 2>/dev/null; then
          echo "sandbox-journal: /var/log/journal already bound -- nothing to do"
        elif ! ${pkgs.util-linux}/bin/mountpoint -q "$pvc" 2>/dev/null; then
          echo "sandbox-journal: $pvc is not a mountpoint -- journal stays container-local (lost on restart)"
        else
          ${pkgs.coreutils}/bin/mkdir -p "$jdir"

          # Keep the newest N prior boots (the current boot's dir does not exist yet).
          keep=${toString cfg.keepBoots}
          n=$(${pkgs.coreutils}/bin/ls -1 "$jdir" 2>/dev/null | ${pkgs.coreutils}/bin/wc -l)
          if [ "$n" -gt "$keep" ]; then
            ${pkgs.coreutils}/bin/ls -1dt "$jdir"/*/ 2>/dev/null \
              | ${pkgs.coreutils}/bin/tail -n +$((keep + 1)) \
              | while read -r old; do ${pkgs.coreutils}/bin/rm -rf "$old"; done
            echo "sandbox-journal: pruned $((n - keep)) boot(s), keeping $keep"
            n=$(${pkgs.coreutils}/bin/ls -1 "$jdir" 2>/dev/null | ${pkgs.coreutils}/bin/wc -l)
          fi

          ${pkgs.coreutils}/bin/mkdir -p /var/log/journal
          if err=$(${pkgs.util-linux}/bin/mount --bind "$jdir" /var/log/journal 2>&1); then
            echo "sandbox-journal: /var/log/journal -> $jdir ($n prior boot(s) readable)"
          else
            echo "sandbox-journal: bind FAILED -- journal stays container-local (lost on restart)"
            echo "sandbox-journal: mount said: $err"
          fi
        fi
      '';
    };
  };
}
