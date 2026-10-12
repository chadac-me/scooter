/**
 * Tier 2: the agent self-modify live switch in a real container.
 *
 * Uploads a module to a writable path and runs `scooter-apply-module --module <path>`,
 * asserting that a good module applies live with a new generation registered, and that a
 * bad module fails the apply while the good tool keeps working. Gated on RUN_CLUSTER_TESTS=1;
 * OVERLAY_IMAGE selects the image.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-selfmod-test";
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os:latest";
const POD = "self-modify-boot";
const SELECTOR = "app=self-modify-boot";
const UPPER = "/nix/.scooter-rw";

// A good module declaring its own tool, which is built during the switch.
const GOOD_MODULE = `{ pkgs, ... }: {
  environment.systemPackages = [
    (pkgs.writeShellScriptBin "selfmod-demo" ''exec \${pkgs.hello}/bin/hello "$@"'')
  ];
}`;
// A bad module that fails eval.
const BAD_MODULE = `{ ... }: { environment.systemPackages = [ thisIsNotDefined ]; }`;

async function waitForUnit(cluster: Cluster, unit: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await cluster.exec(SELECTOR, ["systemctl", "is-active", unit], NS);
    const s = r.stdout.trim();
    if (s !== "activating" && s !== "") return s;
    if (Date.now() > deadline) return s;
    await new Promise((res) => setTimeout(res, 2000));
  }
}

maybe("agent self-modify live switch works in a real container", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster
      .apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } })
      .catch(() => {});

    // Delete a lingering pod from a crashed prior run and wait until it is gone before recreating it.
    await cluster.deletePod(POD, NS).catch(() => {});
    for (let i = 0; i < 60; i++) {
      const gone = await cluster.get("Pod", POD, NS).then(() => false).catch(() => true);
      if (gone) break;
      await new Promise((res) => setTimeout(res, 1000));
    }

    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: "self-modify-boot" } },
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

  it("reaches Running + the overlay store is up", async () => {
    await cluster.waitFor<{ status: { phase: string } }>(
      "Pod",
      POD,
      (p) => p.status?.phase === "Running",
      180_000,
      NS,
    );
    expect(await waitForUnit(cluster, "overlay-store-setup.service", 120_000)).toBe("active");
  });

  it("applies a GOOD module live — the tool appears, a generation is registered", async () => {
    const prof = "/nix/var/nix/profiles";
    const genBefore = (await cluster.exec(SELECTOR, ["readlink", "-f", `${prof}/system`], NS)).stdout.trim();

    // Before: the tool is absent.
    const before = await cluster.exec(SELECTOR, ["sh", "-c", "command -v selfmod-demo; echo $?"], NS);
    expect(before.stdout.trim().split("\n").pop()).not.toBe("0");

    // The first apply is a cold build of a whole new system toplevel, hence the generous timeout.
    await cluster.exec(SELECTOR, ["sh", "-c", `mkdir -p /run/sm && cat > /run/sm/module.nix <<'EOF'\n${GOOD_MODULE}\nEOF`], NS);
    const apply = await cluster.exec(
      SELECTOR,
      ["scooter-apply-module", "--module", "/run/sm/module.nix"],
      NS,
    );
    expect(apply.exitCode).toBe(0);

    // A new generation was registered and the running system advanced to it.
    const genAfter = (await cluster.exec(SELECTOR, ["readlink", "-f", `${prof}/system`], NS)).stdout.trim();
    expect(genAfter).not.toBe(genBefore);
    const current = (await cluster.exec(SELECTOR, ["readlink", "-f", "/run/current-system"], NS)).stdout.trim();
    expect(current).toBe(genAfter);
    // Run the tool via the new system's sw/bin, since a long-lived exec shell may still hold the pre-switch PATH.
    const run = await cluster.exec(SELECTOR, ["sh", "-lc", `${current}/sw/bin/selfmod-demo`], NS);
    expect(run.stdout).toContain("Hello, world!");
    expect((await cluster.exec(SELECTOR, ["ps", "-o", "comm=", "-p", "1"], NS)).stdout.trim()).toBe("systemd");
  }, 900_000);

  it("a BAD module fails the apply and leaves the good environment intact", async () => {
    await cluster.exec(SELECTOR, ["sh", "-c", `cat > /run/sm/bad.nix <<'EOF'\n${BAD_MODULE}\nEOF`], NS);
    const apply = await cluster.exec(SELECTOR, ["scooter-apply-module", "--module", "/run/sm/bad.nix"], NS);
    expect(apply.exitCode).not.toBe(0);

    // The previously applied good tool still works.
    const current = (await cluster.exec(SELECTOR, ["readlink", "-f", "/run/current-system"], NS)).stdout.trim();
    const run = await cluster.exec(SELECTOR, ["sh", "-lc", `${current}/sw/bin/selfmod-demo`], NS);
    expect(run.stdout).toContain("Hello, world!");
  }, 300_000);
});
