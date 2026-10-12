# D-Bus inside the pod: the classic `dbus` daemon, because dbus-broker's
# `Type=notify` readiness signal never reaches systemd under `boot.isContainer`
# and the bus stays `activating` forever, and bus/logind units that a live
# switch (scooter-apply-module) leaves running, because restarting the bus
# mid-switch tears down the scope the switch itself depends on. Both are gated
# on `boot.isContainer` so a nixosTest VM keeps stock behavior.

{ config, lib, ... }:

let
  inContainer = config.boot.isContainer or false;

  # Units that reload new config in place and are never stopped during a switch.
  surviveSwitch = {
    restartIfChanged = false;
    stopIfChanged = false;
    unitConfig.X-StopOnReconfiguration = false;
  };
in
{
  config = lib.mkIf inContainer {
    services.dbus.implementation = lib.mkForce "dbus";

    systemd.services.dbus = surviveSwitch // {
      # A reload makes the daemon re-read its policy, after which the next switch's Manager.Subscribe call is rejected.
      reloadIfChanged = lib.mkForce false;
    };
    systemd.services.systemd-logind = surviveSwitch;
  };
}
