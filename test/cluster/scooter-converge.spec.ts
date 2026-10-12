/**
 * Tier-2 cluster: the deployment `.scooter` injection path end to end in the real OCI image.
 *
 * A deployment ships a `.scooter` ConfigMap (module.nix, flake.nix and a tool source) mounted at
 * /etc/agent-sandbox/scooter; the boot unit runs `scooter-apply-module --detach`, which builds
 * and switches to the base plus the mounted module in the background. The module declares the
 * tool as a `programs.injectedTools` stub resolving `path:/etc/agent-sandbox/scooter#<tool>`, so
 * after the boot converge the tool is on PATH and builds on first call. The spec asserts both
 * that the tool lands on PATH and that the async status reaches a terminal state.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-converge-test";
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os:latest";
const POD = "converge-boot";
const SELECTOR = "app=converge-boot";
const UPPER = "/nix/.scooter-rw";
const SCOOTER_MOUNT = "/etc/agent-sandbox/scooter";
const STATUS = "/run/scooter/env-switch/status";
const TOOL = "review-app";

// Pod-side store diagnostic dumped when the converge does not reach 'done'; the control path (/run/current-system) distinguishes a registration gap from a pod that is not reading the baked DB at all.
const STORE_DIAGNOSTIC = [
  "set +e",
  'echo "--- nix.conf ---"; cat /etc/nix/nix.conf 2>&1',
  'echo "--- nix store mounts ---"; grep nix /proc/mounts 2>&1',
  'echo "--- baked lower db ---"; ls -l /nix/var/nix/db/ 2>&1',
  'echo "--- overlay upper state ---"; ls -lR /nix/.scooter-rw/state 2>&1 | head -20',
  // Pass the experimental features explicitly so the diagnostic cannot die on a missing feature.
  "EF='--extra-experimental-features nix-command --extra-experimental-features read-only-local-store --extra-experimental-features local-overlay-store'",
  "AP=$(readlink -f /run/current-system/sw/bin/scooter-apply-module)",
  "TREE=$(grep -o '/nix/store/[a-z0-9]*-sandbox-os-src' \"$AP\" | head -1)",
  'echo "tree=$TREE"',
  'echo "--- tree present on disk? ---"; ls -ld "$TREE" "/nix/.scooter-ro/${TREE#/nix/store/}" 2>&1',
  'echo "--- tree: merged (local-overlay) store ---"; nix $EF path-info "$TREE" 2>&1 | head -3',
  "echo \"--- tree: lower store only ---\"; nix $EF path-info --store 'local?root=/&real=/nix/.scooter-ro&read-only=true' \"$TREE\" 2>&1 | head -3",
  'echo "--- CONTROL (current system) : merged ---"; nix $EF path-info "$(readlink -f /run/current-system)" 2>&1 | head -3',
  "echo \"--- CONTROL : lower store only ---\"; nix $EF path-info --store 'local?root=/&real=/nix/.scooter-ro&read-only=true' \"$(readlink -f /run/current-system)\" 2>&1 | head -3",
  // `nix-store -r` performs the same validity check the converge makes; `nix eval` would skip it in readOnlyMode.
  'echo "--- nix-store -r (the real validity check) ---"; nix-store -r "$TREE" 2>&1 | head -4',
  // The diagnostic must only observe, never retry the converge.
  'echo "--- when did it fail vs now? ---"; date; ls -l --time-style=full-iso /run/scooter/env-switch/ 2>&1',
  // A large uncheckpointed WAL in the upper's state DB means the store was still settling when the converge asked.
  'echo "--- overlay upper state db ---"; ls -l /nix/.scooter-rw/state/db/ 2>&1',
  'echo "--- disk ---"; df -h /nix/.scooter-rw / 2>&1',
  'echo "--- units ---"; journalctl -b --no-pager -u overlay-store-setup -u nix-daemon -u scooter-apply-module 2>&1 | tail -40',
].join("\n");

// A minimal deployment `.scooter` dir: module.nix declares the tool as an injected tool resolved from ./flake.nix at runtime.
const MODULE_NIX = `{ config, lib, pkgs, ... }:
{
  programs.injectedTools.tools.${TOOL} = {
    package = "${TOOL}";
    flake = "${SCOOTER_MOUNT}";
  };
}
`;

// nixpkgs must be a declared input with a github: url so the --impure stub build resolves it against the sandbox's pinned registry.
const FLAKE_NIX = `{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs";
  outputs = { self, nixpkgs }:
    let system = "x86_64-linux";
    in {
      packages.\${system}.${TOOL} =
        nixpkgs.legacyPackages.\${system}.writeShellScriptBin "${TOOL}"
          (builtins.readFile ./review-app.sh);
    };
}
`;

const TOOL_SH = `#!/usr/bin/env bash
echo "review-app: fake deployment tool (help)"
`;

async function podStatus(cluster: Cluster): Promise<string> {
  const r = await cluster.exec(SELECTOR, ["sh", "-c", `cat ${STATUS} 2>/dev/null || true`], NS);
  return r.stdout.trim();
}

maybe("scooter .scooter injection: seed → boot converge → tool on PATH (k3d, real image)", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster.apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } }).catch(() => {});

    // The seeded .scooter files as a ConfigMap, applied before the pod so it mounts from birth.
    await cluster.apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "scooter-module", namespace: NS },
      data: { "module.nix": MODULE_NIX, "flake.nix": FLAKE_NIX, "review-app.sh": TOOL_SH },
    });

    // Delete a lingering pod from a crashed prior run first.
    await cluster.deletePod(POD, NS).catch(() => {});
    for (let i = 0; i < 60; i++) {
      const gone = await cluster.get("Pod", POD, NS).then(() => false).catch(() => true);
      if (gone) break;
      await new Promise((res) => setTimeout(res, 1000));
    }

    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: "converge-boot" } },
      spec: {
        containers: [
          {
            name: "sandbox",
            image: IMAGE,
            imagePullPolicy: "Never",
            securityContext: { privileged: true },
            volumeMounts: [
              { name: "run", mountPath: "/run" },
              { name: "tmp", mountPath: "/tmp" },
              { name: "overlay-upper", mountPath: UPPER },
              { name: "scooter", mountPath: SCOOTER_MOUNT, readOnly: true },
            ],
          },
        ],
        volumes: [
          { name: "run", emptyDir: { medium: "Memory" } },
          { name: "tmp", emptyDir: { medium: "Memory" } },
          { name: "overlay-upper", emptyDir: {} },
          { name: "scooter", configMap: { name: "scooter-module" } },
        ],
      },
    });
  }, 60_000);

  afterAll(async () => {
    await cluster?.deletePod(POD, NS).catch(() => {});
  });

  it("reaches Running and mounts all three .scooter files", async () => {
    await cluster.waitFor<{ status: { phase: string } }>(
      "Pod",
      POD,
      (p) => p.status?.phase === "Running",
      120_000,
      NS,
    );
    const ls = await cluster.exec(SELECTOR, ["ls", SCOOTER_MOUNT], NS);
    expect(ls.stdout).toContain("module.nix");
    expect(ls.stdout).toContain("flake.nix");
    expect(ls.stdout).toContain("review-app.sh");
  });

  it("the boot --detach converge runs and reaches a terminal status (not wedged at 'building'/'switching')", async () => {
    let status = "";
    for (let i = 0; i < 60; i++) {
      status = await podStatus(cluster);
      if (status === "done" || status === "failed") break;
      await new Promise((res) => setTimeout(res, 5000));
    }
    // On any non-done status, dump the pod's env-switch error, log tail and store diagnostic so the failure is visible after the cluster is torn down.
    if (status !== "done") {
      const err = await cluster
        .exec(SELECTOR, ["sh", "-c", "cat /run/scooter/env-switch/error 2>/dev/null || true"], NS)
        .then((r) => r.stdout.trim())
        .catch(() => "");
      const log = await cluster
        .exec(SELECTOR, ["sh", "-c", "tail -50 /run/scooter/env-switch/log 2>/dev/null || true"], NS)
        .then((r) => r.stdout)
        .catch(() => "");
      const store = await cluster
        .exec(SELECTOR, ["sh", "-c", STORE_DIAGNOSTIC], NS)
        .then((r) => r.stdout)
        .catch((e) => `(diagnostic failed: ${e})`);
      // eslint-disable-next-line no-console
      console.error(`\n=== scooter-apply-module did not reach 'done' (status='${status}') ===\nerror: ${err}\n--- log tail ---\n${log}\n--- store diagnostic ---\n${store}\n=== end ===\n`);
    }
    expect(status, `env-switch status was '${status}' (empty/building/switching = the converge never completed)`).toBe("done");
  }, 320_000);

  it("the seeded lazy tool lands on PATH after the converge", async () => {
    // Query the current system's sw/bin directly, since a long-lived exec shell may still hold the pre-switch PATH.
    const current = (await cluster.exec(SELECTOR, ["readlink", "-f", "/run/current-system"], NS)).stdout.trim();
    const which = await cluster.exec(SELECTOR, ["sh", "-c", `ls ${current}/sw/bin/${TOOL}; echo $?`], NS);
    expect(which.stdout.trim().split("\n").pop()).toBe("0");

    // The first call builds the tool and interleaves build logs with its output, so assert on the second, cached run against both streams.
    await cluster.exec(SELECTOR, ["sh", "-lc", `${current}/sw/bin/${TOOL} || true`], NS);
    const run = await cluster.exec(SELECTOR, ["sh", "-lc", `${current}/sw/bin/${TOOL}`], NS);
    expect(`${run.stdout}${run.stderr}`).toContain("review-app");
  }, 300_000);
});
