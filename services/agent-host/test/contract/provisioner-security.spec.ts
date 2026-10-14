/**
 * The sandbox pod's cgroup-isolation posture. A privileged container runs in the host
 * cgroup namespace, where the sandbox's systemd PID 1 would drive the host cgroup tree,
 * so the systemd sandbox runs non-privileged under a cgroup-delegating runtimeClass
 * with SYS_ADMIN, and the generic image stays plain with no runtimeClass or caps.
 */

import { describe, it, expect } from "vitest";

import { sandboxManifest } from "../../src/session/k8sProvisioner.js";

type SecCtx = {
  privileged?: boolean;
  capabilities?: { add?: string[]; drop?: string[] };
};
type Manifest = {
  spec: {
    podTemplate: {
      spec: {
        runtimeClassName?: string;
        containers: Array<{ securityContext?: SecCtx }>;
      };
    };
  };
};

const render = (systemdImage: boolean, deploy: Record<string, unknown> = {}) =>
  sandboxManifest("abc", "conv-abc", "sandbox-abc", "img:latest", "ns", "aud", "10Gi", systemdImage, deploy) as Manifest;

const podSpec = (m: Manifest) => m.spec.podTemplate.spec;
const ctxOf = (m: Manifest) => podSpec(m).containers[0].securityContext;

describe("sandboxManifest cgroup isolation", () => {
  it("does NOT run the systemd sandbox as privileged (privileged => host cgroup ns => node contention)", () => {
    expect(ctxOf(render(true))?.privileged).not.toBe(true);
  });

  it("sets the configured sandbox runtimeClass on the systemd sandbox (cgroup-delegating runtime, e.g. crun)", () => {
    const m = render(true, { sandboxRuntimeClass: "crun" });
    expect(podSpec(m).runtimeClassName).toBe("crun");
  });

  it("omits runtimeClassName when none is configured (cluster default runtime)", () => {
    expect(podSpec(render(true)).runtimeClassName).toBeUndefined();
  });

  it("grants SYS_ADMIN to the systemd sandbox (NixOS stage-2 specialfs mounts /proc,/dev,/run) — non-privileged", () => {
    // Stage-2's `specialfs` snippet mounts /proc, /dev and /run, which needs the mount capability.
    const ctx = ctxOf(render(true, { sandboxRuntimeClass: "crun" }));
    expect(ctx?.capabilities?.add ?? []).toContain("SYS_ADMIN");
    expect(ctx?.privileged).not.toBe(true);
  });

  it("leaves the legacy generic (non-systemd) image plain: unprivileged, no runtimeClass, no caps", () => {
    const m = render(false, { sandboxRuntimeClass: "crun" });
    expect(ctxOf(m)?.privileged).not.toBe(true);
    expect(ctxOf(m)?.capabilities?.add ?? []).not.toContain("SYS_ADMIN");
    expect(podSpec(m).runtimeClassName).toBeUndefined();
  });
});
