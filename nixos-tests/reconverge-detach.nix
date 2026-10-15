# nixosTest: the DETACHED apply, which is the path the boot unit takes on every
# pod start — so it is what re-applies the agent's local modules after a
# suspend/resume. Its child runs as a transient unit with systemd's PATH, not the
# agent shell's, so every tool it needs must come from the script's own
# runtimeInputs; a missing one fails here and nowhere else. No toplevel is built
# (nixpkgs is /dev/null): this asserts the status protocol always reaches a
# terminal state, because a stuck "building" is indistinguishable from a slow
# build and silently drops the agent's environment.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-reconverge-detach";

  nodes.machine = { lib, ... }: {
    imports = [ sandboxModule ];
    programs.scooterModule.enable = true;
    # No in-pod build can succeed here; the status protocol is what is under test.
    programs.scooterModule.nixpkgs = lib.mkForce "/dev/null";
    # applyOnBoot is left at its default so the boot unit itself runs.
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    machine.wait_for_unit("scooter-apply-module.service")

    # The boot apply with nothing to converge must settle at idle rather than sit
    # in the "building" its detached parent wrote.
    machine.wait_until_succeeds(
        "test \"$(cat /run/scooter/env-switch/status)\" = idle", timeout=120
    )
    assert "ready" in machine.succeed("scooter-rebuild status")

    # A local module takes the detached child past the probe and into the build,
    # which fails here — and a failure must be REPORTED, not left as "building".
    machine.succeed("scooter-rebuild module new mytool")
    machine.succeed("scooter-apply-module --detach")
    machine.wait_until_succeeds(
        "test \"$(cat /run/scooter/env-switch/status)\" = failed", timeout=300
    )
    machine.fail("scooter-rebuild status")
    # `log` is the driver's own logger, so the switch log needs its own name.
    switch_log = machine.succeed("cat /run/scooter/env-switch/log")
    assert "building toplevel" in switch_log, \
        f"the detached child never reached the build: {switch_log!r}"
  '';
}
