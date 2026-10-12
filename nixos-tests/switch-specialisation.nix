# nixosTest: a running system re-converges to a different config at runtime via
# `switch-to-configuration` without a reboot and without restarting PID 1. It
# boots a base config with the sample service off, activates a pre-built
# specialisation live from /run/current-system/specialisation/<name>/bin, and
# asserts the service comes up while systemd stays the same PID 1.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-switch-specialisation";

  nodes.machine = { config, lib, pkgs, ... }: {
    # Import only the service module so the base is generic with the service off.
    imports = [ "${sandboxModule}/sample-service.nix" ];

    services.sampleDevService.enable = false;

    # A pre-built specialisation that turns the service on; mkForce wins over the inherited base value.
    specialisation.withService.configuration = {
      services.sampleDevService = { enable = lib.mkForce true; port = 8888; };
    };
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")

    # Base config: the specialised service is not running.
    machine.fail("systemctl is-active sample-dev-service.service")

    pid1_before = machine.succeed("stat -c %Y /proc/1").strip()

    # Switch to the specialisation live.
    machine.succeed(
      "/run/current-system/specialisation/withService/bin/switch-to-configuration switch"
    )

    # The service is now up and listening.
    machine.wait_for_unit("sample-dev-service.service")
    machine.wait_for_open_port(8888)

    # systemd is still the same PID 1, with its start time unchanged.
    machine.succeed("test \"$(ps -o comm= -p 1)\" = systemd")
    pid1_after = machine.succeed("stat -c %Y /proc/1").strip()
    assert pid1_before == pid1_after, f"PID 1 was restarted by the switch ({pid1_before} -> {pid1_after})"

    # The specialised service can be stopped directly; switching back to the base does not reliably stop units the specialisation added, so that is not asserted.
    machine.succeed("systemctl stop sample-dev-service.service")
    machine.wait_until_fails("systemctl is-active sample-dev-service.service")
  '';
}
