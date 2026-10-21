# nixosTest: the scooter-rebuild CLI's module-authoring workflow (new, list, show,
# edit, rm on /etc/scooter/modules) and its dispatch to the switch/status machinery.
# It does not run a full toplevel rebuild; dev-env-scooter-module and the Tier-2
# cluster tests cover that.

{ pkgs, lib, sandboxModule }:

pkgs.testers.runNixOSTest {
  name = "dev-env-scooter-rebuild";

  nodes.machine = { lib, ... }: {
    imports = [ sandboxModule ];
    programs.scooterModule.enable = true;
    # The option is required even though no in-pod build runs here.
    programs.scooterModule.nixpkgs = lib.mkForce "/dev/null";
    programs.scooterModule.applyOnBoot = lib.mkForce false;
  };

  testScript = ''
    machine.wait_for_unit("default.target")

    # /etc/scooter/modules is the tmpfiles symlink to the workspace PVC dir.
    machine.succeed("test -L /etc/scooter/modules")
    machine.succeed("test -d /etc/scooter/modules")

    # list on an empty dir prints the hint and exits 0.
    out = machine.succeed("scooter-rebuild module list")
    assert "no modules yet" in out, f"expected empty hint, got: {out!r}"

    # new creates modules/<name>.nix from a template.
    machine.succeed("scooter-rebuild module new mytool")
    machine.succeed("test -f /etc/scooter/modules/mytool.nix")
    # It lands on the real PVC path behind the symlink.
    machine.succeed("test -f /workspace/.scooter/modules/mytool.nix")

    # list shows it by bare name.
    listed = machine.succeed("scooter-rebuild module list").strip()
    assert listed == "mytool", f"expected 'mytool', got: {listed!r}"

    shown = machine.succeed("scooter-rebuild module show mytool")
    assert "NixOS module" in shown, f"template not shown: {shown!r}"

    # new on an existing name must not clobber it.
    machine.fail("scooter-rebuild module new mytool")

    # edit opens $EDITOR on the module file; a script that appends a marker proves it targets the right path.
    machine.succeed(
        "printf '#!/bin/sh\\nprintf \"# edited\\\\n\" >> \"$1\"\\n' > /tmp/ed && chmod +x /tmp/ed"
    )
    machine.succeed("EDITOR=/tmp/ed scooter-rebuild module edit mytool")
    machine.succeed("grep -q '# edited' /etc/scooter/modules/mytool.nix")
    # edit on a non-existent module creates it first.
    machine.succeed("EDITOR=/tmp/ed scooter-rebuild module edit fresh")
    machine.succeed("test -f /etc/scooter/modules/fresh.nix")
    machine.succeed("scooter-rebuild module rm fresh")

    # Path-traversal names are rejected.
    machine.fail("scooter-rebuild module new ../evil")
    machine.fail("scooter-rebuild module show foo/bar")

    machine.succeed("scooter-rebuild module rm mytool")
    machine.fail("test -e /etc/scooter/modules/mytool.nix")
    assert "no modules yet" in machine.succeed("scooter-rebuild module list")

    # status wraps scooter-env-status and reports ready before any switch.
    st = machine.succeed("scooter-rebuild status")
    assert "ready" in st, f"status not ready: {st!r}"

    # An empty or whitespace-only module is a no-op; nixpkgs=/dev/null here would fail any real build, so this proves the guard skips it.
    machine.succeed(": > /tmp/empty-module.nix")
    out = machine.succeed("scooter-apply-module --module /tmp/empty-module.nix 2>&1")
    assert "nothing to apply" in out, f"empty module not skipped: {out!r}"
    machine.succeed("printf '   \\n\\t\\n' > /tmp/ws-module.nix")
    out = machine.succeed("scooter-apply-module --module /tmp/ws-module.nix 2>&1")
    assert "nothing to apply" in out, f"whitespace module not skipped: {out!r}"
    # Status reflects ready after the no-op.
    assert "ready" in machine.succeed("scooter-rebuild status")

    # Unknown commands exit non-zero with usage.
    machine.fail("scooter-rebuild bogus")
    machine.fail("scooter-rebuild module bogus")
    # --help prints the command list to stderr with the usage exit code.
    help = machine.succeed("scooter-rebuild --help 2>&1 || true")
    assert "scooter-rebuild switch" in help, f"help missing commands: {help!r}"
  '';
}
