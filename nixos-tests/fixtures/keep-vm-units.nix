# Test fixture layered into every re-converge via
# programs.scooterModule.extraReconvergeModules. scooter-apply-module rebuilds from
# the shared base config, which in a VM differs from the test framework's booted
# node config, so the switch acts on differences that exist only here; this module
# reconciles the ones that would break the switch or the test. A pod's booted
# system is the base config itself, so none of this applies there.

{ lib, ... }:
{
  # The driver's control channel: declaring a same-named no-op unit keeps the switch from stopping the running one as a removed unit.
  systemd.services.backdoor = {
    restartIfChanged = false;
    stopIfChanged = false;
    unitConfig.X-StopOnReconfiguration = false;
    serviceConfig.ExecStart = lib.mkDefault "/bin/true";
  };

  # Keep the boot-apply unit off, or the rebuilt toplevel gains a new scooter-apply-module.service that the switch starts mid-switch, fails, and reads as its own failure.
  programs.scooterModule.applyOnBoot = lib.mkForce false;

  # No gettys on the driver's console, matching the framework's test-instrumentation.nix, or a login prompt interleaves into the driver's base64 stream.
  systemd.services."serial-getty@ttyS0".enable = false;
  systemd.services."serial-getty@hvc0".enable = false;
  systemd.services."getty@tty1".enable = false;
  systemd.services."autovt@".enable = false;
}
