# nixosTest: the nix-dev-env skill's documented "install a tool with nix"
# workflow works, so the skill cannot drift from reality. The package is
# pre-seeded in the store so the install resolves offline.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-nix-build-skill";

  nodes.machine = { config, pkgs, lib, ... }: {
    imports = [ sandboxModule ];

    # Pin the `nixpkgs` registry at the test's own source and pre-seed it with the built `hello`, so the install is offline.
    devEnvNix.nixpkgs = lib.mkForce "path:${pkgs.path}";
    system.extraDependencies = [ pkgs.hello pkgs.path ];
  };

  testScript = ''
    machine.wait_for_unit("default.target")
    machine.wait_for_unit("nix-daemon.socket")

    # The skill's canonical install step.
    machine.succeed("nix profile install nixpkgs#hello")

    # A login shell picks up ~/.nix-profile/bin and the tool runs.
    hello = machine.succeed("bash -l -c 'command -v hello'").strip()
    assert "nix-profile" in hello, f"hello not under the nix profile: {hello!r}"
    machine.succeed("bash -l -c 'hello' >/dev/null")

    # The base config keeps the build sandbox off (see nix-config.nix); only nix-sandbox-probe turns it on.
    machine.succeed("grep -qx 'sandbox = false' /etc/nix/nix.conf")
    # The VM has user namespaces and an unmasked /proc, so the probe passes and turns the sandbox on.
    machine.wait_for_unit("nix-sandbox-probe.service")
    sandbox = machine.succeed("nix config show sandbox").strip()
    assert sandbox == "true", f"nix-sandbox-probe should enable the build sandbox in a VM, got {sandbox!r}"
  '';
}
