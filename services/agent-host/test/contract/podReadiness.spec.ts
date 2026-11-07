/**
 * A sandbox pod that won't go Ready is explained, so a tool call reports "its storage
 * volume can't attach" rather than a bare timeout.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { describePodNotReady, formatPodWait, podWaitStatus, setPodWaitStatus } from "../../src/exec/podReadiness.js";
import { pollForReadyPod } from "../../src/exec/k8sExec.js";
import type { SandboxRef } from "../../src/types.js";

const NOW = Date.parse("2026-11-07T01:00:00Z");
const REF: SandboxRef = { name: "conv-nt4eo0", namespace: "agent-manager" };
const pending = (extra: Record<string, unknown> = {}) => ({
  metadata: { name: "conv-nt4eo0", creationTimestamp: new Date(NOW - 12 * 60_000) },
  spec: { nodeName: "node-a" },
  status: {
    phase: "Pending",
    containerStatuses: [{ name: "sandbox", ready: false, state: { waiting: { reason: "ContainerCreating" } } }],
  },
  ...extra,
});
const ev = (reason: string, message: string, minsAgo: number, count = 1) => ({
  type: "Warning",
  reason,
  message,
  count,
  lastTimestamp: new Date(NOW - minsAgo * 60_000),
  involvedObject: {},
  metadata: {},
});

describe("describePodNotReady", () => {
  it("names a volume that won't attach, with the event message and pod age", () => {
    const d = describePodNotReady(
      pending() as never,
      [ev("FailedAttachVolume", "AttachVolume.Attach failed for volume \"pvc-1\" : timed out waiting for external-attacher", 1, 7)] as never,
      NOW,
    );
    expect(d.storage).toBe(true);
    expect(d.reason).toMatch(/storage volume can't attach/);
    expect(d.reason).toMatch(/12m/);
    expect(d.reason).toMatch(/FailedAttachVolume, 7 times: AttachVolume.Attach failed/);
  });

  it("prefers the newest storage warning", () => {
    const d = describePodNotReady(
      pending() as never,
      [ev("FailedAttachVolume", "old", 10), ev("FailedMount", "Unable to attach or mount volumes", 1)] as never,
      NOW,
    );
    expect(d.reason).toMatch(/can't be mounted.*FailedMount/);
  });

  it("treats an unbound PVC scheduling failure as storage", () => {
    const d = describePodNotReady(
      pending({ spec: {} }) as never,
      [ev("FailedScheduling", "0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims", 1)] as never,
      NOW,
    );
    expect(d).toMatchObject({ storage: true });
    expect(d.reason).toMatch(/can't be scheduled/);
  });

  it("falls back to the pod's own status without events", () => {
    expect(describePodNotReady(pending() as never, [], NOW)).toEqual({
      reason: "the container is still being created (pod waiting 12m)",
      storage: false,
    });
    expect(describePodNotReady(undefined).reason).toBe("no sandbox pod exists yet");
  });
});

describe("pollForReadyPod diagnosis", () => {
  beforeEach(() => setPodWaitStatus(REF, undefined));

  it("puts the storage cause in the 'no ready pod' error and keeps it for conversation_status", async () => {
    const err = await pollForReadyPod(REF, {
      listCandidates: async () => [pending() as never],
      diagnose: async () => ({ reason: "a storage volume can't attach to the node", storage: true }),
      sleep: async () => {},
      deadlineMs: -1,
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/no ready pod for sandbox agent-manager\/conv-nt4eo0: storage unavailable, a storage volume can't attach/);
    const w = podWaitStatus(REF);
    expect(w?.storage).toBe(true);
    expect(formatPodWait(w!)).toMatch(/^sandbox storage is unavailable/);
  });

  it("clears the cause once the pod is Ready", async () => {
    setPodWaitStatus(REF, { reason: "x", storage: true, since: Date.now() });
    await pollForReadyPod(REF, {
      listCandidates: async () => [{ metadata: { name: "p" }, status: { phase: "Running", containerStatuses: [{ ready: true }] } } as never],
      sleep: async () => {},
    });
    expect(podWaitStatus(REF)).toBeUndefined();
  });

  it("forgets a cause that hasn't been rechecked for 5 minutes", () => {
    setPodWaitStatus(REF, { reason: "x", storage: true, since: Date.now() });
    expect(podWaitStatus(REF, Date.now() + 6 * 60_000)).toBeUndefined();
  });
});
