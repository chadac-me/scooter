/**
 * Tier-2 cluster: `scooter-rebuild switch` run repeatedly in one pod.
 *
 * scooter-apply-module decides success from a failed-unit diff rather than the switch's
 * exit code, so a switch that aborts before touching any unit reports success having done
 * nothing; every assertion here is therefore on the observed effect (the marker changed),
 * never on the exit code or a log string. When SANDBOX_RUNTIME_CLASS names a
 * cgroup-delegating runtime the pod runs unprivileged with CAP_SYS_ADMIN, the shape
 * k8sProvisioner.ts uses, and the first test asserts the cgroup isolation holds before any
 * switch runs.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-rebuild-twice";
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os:latest";
const POD = "rebuild-twice";
const SELECTOR = "app=rebuild-twice";
const UPPER = "/nix/.scooter-rw";
/** Cgroup-delegating runtime class for the pod; unset on CI, which has no crun RuntimeClass and a disposable node. */
const RUNTIME_CLASS = process.env.SANDBOX_RUNTIME_CLASS;
/** Cgroup isolation is required whenever a runtime class is set. */
const REQUIRE_ISOLATION = RUNTIME_CLASS !== undefined;

/** A module adding a marker unit so each switch has a real diff to apply; a unit rather than environment.etc because kubernetes bind-mounts parts of /etc read-only. */
const MARKER_UNIT = "scooter-switch-marker";
const moduleFor = (marker: string) => `{ config, lib, pkgs, ... }:
{
  systemd.services."${MARKER_UNIT}" = {
    description = "switch marker ${marker}";
    serviceConfig.Type = "oneshot";
    serviceConfig.RemainAfterExit = true;
    script = "echo ${marker}";
  };
}
`;

maybe("scooter-rebuild, run twice", () => {
  let cluster: Cluster;

  /** Write the marker module, switch, and report what landed. */
  async function switchTo(marker: string) {
    await cluster.exec(
      SELECTOR,
      ["sh", "-c", `mkdir -p /etc/scooter/modules && cat > /etc/scooter/modules/marker.nix <<'NIXEOF'\n${moduleFor(marker)}NIXEOF`],
      NS,
    );
    const r = await cluster.exec(SELECTOR, ["scooter-rebuild", "switch"], NS);
    // Read back what the switch installed from the unit systemd now has loaded.
    const got = await cluster.exec(
      SELECTOR,
      ["sh", "-c", `systemctl cat ${MARKER_UNIT}.service 2>/dev/null | sed -n 's/^Description=switch marker //p'`],
      NS,
    );
    return { applied: got.stdout.trim(), out: `${r.stdout}\n${r.stderr}` };
  }

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster.apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } }).catch(() => {});
    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: "rebuild-twice" } },
      spec: {
        ...(RUNTIME_CLASS ? { runtimeClassName: RUNTIME_CLASS } : {}),
        containers: [
          {
            name: "sandbox",
            image: IMAGE,
            imagePullPolicy: "Never",
            // CAP_SYS_ADMIN is all stage-2 needs under a cgroup-delegating runtime; without one, fall back to privileged.
            securityContext: RUNTIME_CLASS
              ? { capabilities: { add: ["SYS_ADMIN"] } }
              : { privileged: true },
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
    await cluster.waitFor<{ status: { phase: string } }>(
      "Pod", POD, (p) => p.status?.phase === "Running", 180_000, NS,
    );
  }, 240_000);

  afterAll(async () => {
    await cluster?.deletePod(POD, NS).catch(() => {});
  });

  it("runs in its OWN cgroup namespace when a cgroup-delegating runtime is set", async () => {
    // A pod in the host cgroup namespace reports a /kubepods/... path and its systemd would churn the host tree.
    const r = await cluster.exec(SELECTOR, ["sh", "-c", "cat /proc/self/cgroup"], NS);
    if (!REQUIRE_ISOLATION) {
      expect(r.stdout.trim().length, "cgroup path should be readable").toBeGreaterThan(0);
      return;
    }
    expect(
      r.stdout.trim(),
      `pod is in the HOST cgroup namespace despite runtimeClassName=${RUNTIME_CLASS} — ` +
        "its systemd can churn the host cgroup tree and kill your session",
    ).not.toContain("kubepods");
  });

  it("applies a FIRST switch", async () => {
    const { applied, out } = await switchTo("one");
    expect(applied, `first switch did not apply:\n${out.slice(-2500)}`).toBe("one");
  }, 900_000);

  it("applies a SECOND switch in the same pod (the reported dbus-abort case)", async () => {
    const { applied, out } = await switchTo("two");
    expect(
      applied,
      `SECOND switch did not apply — dbus Subscribe abort? Note a no-op here can still ` +
        `report success (the health gate is a failed-unit diff, empty when the switch ` +
        `aborts before touching units).\n${out.slice(-4000)}`,
    ).toBe("two");
  }, 900_000);

  it("applies a THIRD switch (the state is not one-shot)", async () => {
    const { applied, out } = await switchTo("three");
    expect(applied, `THIRD switch did not apply:\n${out.slice(-2500)}`).toBe("three");
  }, 900_000);
});
