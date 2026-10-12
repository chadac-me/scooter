# nixosTest: the systemd journal is written to the workspace PVC early enough to
# hold the records of a boot that crashed. It asserts that /var/log/journal is
# bound to the PVC path on a different device than /, that journald writes there
# from its first record, that the records are files readable without their own
# journald, that prior boots are pruned to keepBoots, that activation is idempotent,
# and that a boot with no PVC still succeeds and says so. /workspace must be a
# `virtualisation.fileSystems` entry with neededForBoot so it is mounted before the
# activation script runs, matching the ordering the kubelet gives the real PVC.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-journal-persist";

  nodes = {
    machine = { ... }: {
      imports = [ sandboxModule ];
      boot.kernelParams = [ "CONVERSATION_ID=conv-test" ];

      virtualisation.fileSystems."/workspace" = {
        device = "tmpfs";
        fsType = "tmpfs";
        neededForBoot = true;
      };
    };

    # Same config, no /workspace: the degraded path must still reach default.target.
    nopvc = { ... }: {
      imports = [ sandboxModule ];
      boot.kernelParams = [ "CONVERSATION_ID=conv-test" ];
    };
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    JDIR = "/workspace/.scooter/journal"

    def dev(p):
        return machine.succeed(f"stat -c %d {p}").strip()

    # --- 1. bound to the PVC, not the root layer. ------------------------------
    machine.succeed("mountpoint -q /var/log/journal")
    assert dev("/var/log/journal") == dev(JDIR), "journal not backed by the PVC path"
    assert dev("/var/log/journal") != dev("/"), "journal still on the root layer"

    # The bind happens in the activation script, so its report lands on the pre-systemd stream: the console here, the container log in production.
    assert "sandbox-journal: /var/log/journal -> " in machine.get_console_log(), \
        "activation did not report the bind on the pre-systemd stream"

    # --- 2. journald wrote to disk from the start, not /run. -------------------
    machine.succeed("grep -q '^Storage=persistent' /etc/systemd/journald.conf")
    machine.succeed("grep -q '^SystemMaxUse=' /etc/systemd/journald.conf")
    machine.succeed(f"test -n \"$(find {JDIR} -name '*.journal' -print -quit)\"")
    machine.succeed("journalctl -b --no-pager | grep -q .")

    # --- 3. the records are files, readable without their own journald. --------
    mid = machine.succeed("cat /etc/machine-id").strip()
    jfile = f"{JDIR}/{mid}/system.journal"
    machine.succeed("systemd-cat -t scooter-probe echo JOURNAL_PROBE_MARKER")
    machine.succeed("journalctl --sync")
    # Restart journald so nothing below can be served from its memory.
    machine.succeed("systemctl restart systemd-journald")
    machine.succeed(f"test -f {jfile}")
    machine.succeed(f"journalctl --no-pager --file {jfile} | grep -q JOURNAL_PROBE_MARKER")
    machine.succeed(f"journalctl --no-pager --directory {JDIR} | grep -q JOURNAL_PROBE_MARKER")
    # -D must also serve --list-boots, which rejects --merge.
    machine.succeed(f"journalctl --no-pager --directory {JDIR} --list-boots | grep -q .")
    machine.fail(f"journalctl --no-pager --merge --directory {JDIR} --list-boots")

    # --- 4. re-activation is idempotent: exactly one mount, never stacked. -----
    # A manual activate returns its report to the driver rather than the console.
    reactivation = machine.succeed("/run/current-system/activate 2>&1")
    mounts = int(machine.succeed("grep -c ' /var/log/journal ' /proc/self/mountinfo").strip())
    assert mounts == 1, f"bind stacked {mounts} deep across re-activation"
    assert "already bound" in reactivation, \
        f"re-activation did not report taking the no-op path: {reactivation}"
    machine.succeed("journalctl -b --no-pager | grep -q .")

    # --- 5. prior boots pruned to keepBoots (default 3). -----------------------
    # Unmount first: the prune sits behind the same guard as the bind, so it only runs when nothing is bound yet.
    machine.succeed("umount /var/log/journal || umount -l /var/log/journal")
    for i in range(5):
        machine.succeed(f"mkdir -p {JDIR}/fakeboot{i} && touch -d '2020-01-0{i+1}' {JDIR}/fakeboot{i}")
    before = int(machine.succeed(f"ls -1 {JDIR} | wc -l").strip())
    assert before == 6, f"expected 6 dirs before prune, got {before}"

    machine.succeed("/run/current-system/activate")
    after = int(machine.succeed(f"ls -1 {JDIR} | wc -l").strip())
    assert after == 3, f"prune should keep 3, kept {after}"
    # The current boot's own directory must survive the prune.
    machine.succeed(f"test -d {JDIR}/{mid}")
    # The same activation re-bound it.
    machine.succeed("mountpoint -q /var/log/journal")
    remounts = int(machine.succeed("grep -c ' /var/log/journal ' /proc/self/mountinfo").strip())
    assert remounts == 1, f"re-bind after prune left {remounts} mounts"

    # --- 6. no PVC: degraded, but booted, and it says which. -------------------
    nopvc.wait_for_unit("default.target")
    nopvc.fail("mountpoint -q /var/log/journal")
    assert "sandbox-journal: /workspace is not a mountpoint" in nopvc.get_console_log(), \
        "degraded boot did not report WHY the journal is container-local"
  '';
}
