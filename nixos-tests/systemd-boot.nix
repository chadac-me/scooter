# nixosTest: the sandbox-os config boots as a real systemd system, reaching
# default.target with journald up and nix usable.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-systemd-boot";

  nodes.machine = { ... }: {
    imports = [ sandboxModule ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    machine.wait_for_unit("systemd-journald.service")
    machine.succeed("journalctl --no-pager -n 1")

    # Running or degraded, never offline.
    state = machine.succeed("systemctl is-system-running || true").strip()
    assert state in ("running", "degraded"), f"unexpected system state: {state}"

    # nix is usable: the daemon is up and `nix` runs.
    machine.wait_for_unit("nix-daemon.socket")
    machine.succeed("nix --version")
  '';
}
