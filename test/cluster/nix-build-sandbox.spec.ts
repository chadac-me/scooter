/**
 * Tier 2: the sandbox image in a user-namespaced pod (hostUsers: false, procMount: Unmasked), the
 * `sandboxUserNamespace` posture. systemd PID 1 boots with SYS_ADMIN that is namespaced rather than
 * host-wide, the overlay store mounts through the idmapped volume, and nix-sandbox-probe turns on
 * Nix's build sandbox so builds run isolated. Gated on RUN_CLUSTER_TESTS=1; needs Kubernetes >= 1.33.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-test";
const IMAGE = process.env.SANDBOX_OS_IMAGE ?? "agent-sandbox-os:latest";
const POD = "nix-build-sandbox";
const SELECTOR = "app=nix-build-sandbox";

maybe("sandbox image in a user-namespaced pod runs Nix builds in Nix's build sandbox", () => {
  let cluster: Cluster;

  const sh = (script: string) => cluster.exec(SELECTOR, ["sh", "-c", script], NS);

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster
      .apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } })
      .catch(() => {});

    // The provisioner's systemd-sandbox shape with sandboxUserNamespace on: no `privileged`.
    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: "nix-build-sandbox" } },
      spec: {
        hostUsers: false,
        containers: [
          {
            name: "sandbox",
            image: IMAGE,
            imagePullPolicy: "Never",
            securityContext: { capabilities: { add: ["SYS_ADMIN"] }, procMount: "Unmasked" },
            volumeMounts: [
              { name: "run", mountPath: "/run" },
              { name: "tmp", mountPath: "/tmp" },
              { name: "scooter-rw", mountPath: "/nix/.scooter-rw" },
              { name: "workspace", mountPath: "/workspace" },
            ],
          },
        ],
        volumes: [
          { name: "run", emptyDir: { medium: "Memory" } },
          { name: "tmp", emptyDir: { medium: "Memory" } },
          { name: "scooter-rw", emptyDir: {} },
          { name: "workspace", emptyDir: {} },
        ],
      },
    });
  }, 60_000);

  afterAll(async () => {
    await cluster?.deletePod(POD, NS).catch(() => {});
  });

  it("reaches Running and systemd settles", async () => {
    await cluster.waitFor<{ status: { phase: string } }>(
      "Pod", POD, (p) => p.status?.phase === "Running", 180_000, NS,
    );
    const deadline = Date.now() + 180_000;
    let state = "";
    for (;;) {
      state = (await sh("systemctl is-system-running")).stdout.trim();
      if (!["initializing", "starting", ""].includes(state) || Date.now() > deadline) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    expect(["running", "degraded"]).toContain(state);
  }, 400_000);

  it("pod root is not host root (uid 0 maps to a non-zero host uid)", async () => {
    const r = await sh("cat /proc/self/uid_map");
    const [inside, outside] = r.stdout.trim().split(/\s+/);
    expect(inside).toBe("0");
    expect(outside).not.toBe("0");
  });

  it("the overlay store is mounted over /nix/store through the idmapped volume", async () => {
    const r = await sh("systemctl is-active overlay-store-setup.service; grep ' /nix/store ' /proc/mounts");
    expect(r.stdout).toContain("active");
    expect(r.stdout).toMatch(/overlay/);
  });

  it("nix-sandbox-probe enabled the build sandbox", async () => {
    const r = await sh("journalctl -u nix-sandbox-probe --no-pager -o cat; nix config show sandbox");
    expect(r.stdout.trim().split("\n").pop()).toBe("true");
  });

  it("a build runs inside the build sandbox (the pod's /workspace is not visible to it)", async () => {
    const expr = [
      "derivation {",
      `  name = "userns-sandbox-probe-\${toString builtins.currentTime}";`,
      "  system = builtins.currentSystem;",
      '  builder = "/bin/sh";',
      "  args = [ \"-c\" \"if [ -e /workspace ]; then echo LEAK > $out; else echo ISOLATED > $out; fi\" ];",
      "}",
    ].join("\n");
    const r = await cluster.exec(
      SELECTOR,
      ["sh", "-c", 'out=$(nix-build --no-out-link -E "$1") && cat "$out"', "_", expr],
      NS,
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("ISOLATED");
  }, 300_000);
});
