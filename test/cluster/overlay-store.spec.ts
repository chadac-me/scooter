/**
 * Tier 2: the read-only-lower plus writable-upper local-overlay Nix store in a real container.
 *
 * Here the lower is the baked image store and there is no register-nix-paths, as in
 * production. The pod must boot systemd PID 1 with the overlay store set up, /nix/store must
 * be the module's overlay, a real `nix build` must land in the upper while the lower stays
 * untouched, and nix must report the local-overlay store. The upper is a disk-backed emptyDir
 * as in production. Gated on RUN_CLUSTER_TESTS=1; OVERLAY_IMAGE selects the image.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
// A dedicated namespace so this spec never conflicts with the other image-boot spec.
const NS = "agent-sandbox-overlay-test";
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os:latest";
const POD = "overlay-store-boot";
const SELECTOR = "app=overlay-store-boot";

// The programs.overlayStore.{lowerPath,upperPath} defaults.
const LOWER = "/nix/.scooter-ro";
const UPPER = "/nix/.scooter-rw";

maybe("local-overlay Nix store works in a real container (prod topology)", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });

    // Nothing else creates the namespace for this image-boot test.
    await cluster
      .apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } })
      .catch(() => {});

    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: "overlay-store-boot" } },
      spec: {
        containers: [
          {
            name: "sandbox", // cluster.exec() targets the "sandbox" container
            image: IMAGE,
            imagePullPolicy: "Never",
            // systemd PID 1 and the overlay setup need a writable cgroup and mount privileges.
            securityContext: { privileged: true },
            volumeMounts: [
              { name: "run", mountPath: "/run" },
              { name: "tmp", mountPath: "/tmp" },
              // The writable upper, a disk-backed emptyDir standing in for the deployer-mounted volume.
              { name: "overlay-upper", mountPath: UPPER },
            ],
          },
        ],
        volumes: [
          { name: "run", emptyDir: { medium: "Memory" } },
          { name: "tmp", emptyDir: { medium: "Memory" } },
          { name: "overlay-upper", emptyDir: {} },
        ],
      },
    });
  }, 60_000);

  afterAll(async () => {
    await cluster?.deletePod(POD, NS).catch(() => {});
  });

  it("reaches Running (systemd PID 1 came up with the overlay store)", async () => {
    const pod = await cluster.waitFor<{ status: { phase: string } }>(
      "Pod",
      POD,
      (p) => p.status?.phase === "Running",
      180_000,
      NS,
    );
    expect(pod.status.phase).toBe("Running");
  });

  it("PID 1 is systemd and overlay-store-setup succeeded", async () => {
    const pid1 = await cluster.exec(SELECTOR, ["ps", "-o", "comm=", "-p", "1"], NS);
    expect(pid1.stdout.trim()).toBe("systemd");

    // The pod can report Running while the early-boot oneshot is still activating, so poll until it settles.
    const state = await waitForUnit("overlay-store-setup.service", 120_000);
    expect(state).toBe("active");
  });

  // Re-exec `systemctl is-active` until the unit settles out of `activating`, returning its terminal state.
  async function waitForUnit(unit: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await cluster.exec(SELECTOR, ["systemctl", "is-active", unit], NS);
      const s = r.stdout.trim();
      if (s !== "activating" && s !== "" ) return s;
      if (Date.now() > deadline) return s;
      await new Promise((res) => setTimeout(res, 2000));
    }
  }

  it("/nix/store is OUR overlay (writable upper mounted)", async () => {
    const mounts = await cluster.exec(SELECTOR, ["cat", "/proc/self/mountinfo"], NS);
    expect(mounts.stdout).toContain(`upperdir=${UPPER}/upper`);
  });

  it("the baked LOWER is read-only", async () => {
    const r = await cluster.exec(SELECTOR, ["sh", "-c", `touch ${LOWER}/canary 2>/dev/null; echo $?`], NS);
    expect(r.stdout.trim()).not.toBe("0");
  });

  it("a real `nix build` lands in the UPPER, not the baked lower", async () => {
    // A trivial derivation whose builder is already in the closure, so the build is offline.
    const expr =
      'derivation { name = "overlay-canary"; system = builtins.currentSystem; ' +
      'builder = "/bin/sh"; args = [ "-c" "echo built-in-upper > $out" ]; }';
    const build = await cluster.exec(
      SELECTOR,
      ["nix", "build", "--no-link", "--print-out-paths", "--impure", "--expr", expr],
      NS,
    );
    expect(build.exitCode).toBe(0);
    const outPath = build.stdout.trim().split("\n").pop()!.trim();
    expect(outPath).toMatch(/^\/nix\/store\/.+-overlay-canary$/);
    const base = outPath.split("/").pop()!;

    // The new path's files live in the upper and not in the lower.
    const inUpper = await cluster.exec(SELECTOR, ["sh", "-c", `test -e ${UPPER}/upper/${base}; echo $?`], NS);
    expect(inUpper.stdout.trim()).toBe("0");

    const inLower = await cluster.exec(SELECTOR, ["sh", "-c", `test -e ${LOWER}/${base}; echo $?`], NS);
    expect(inLower.stdout.trim()).not.toBe("0");

    // It is readable through the merged /nix/store view.
    const content = await cluster.exec(SELECTOR, ["cat", outPath], NS);
    expect(content.stdout.trim()).toBe("built-in-upper");
  });

  it("nix reports the local-overlay store", async () => {
    const store = await cluster.exec(SELECTOR, ["nix", "config", "show", "store"], NS);
    expect(store.stdout).toContain("local-overlay");
  });
});
