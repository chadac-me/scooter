/**
 * The sandbox container carries the resource requests and limits the provisioner is
 * given, and omits the block entirely when none are configured.
 */

import { describe, it, expect } from "vitest";

import { sandboxManifest } from "../../src/session/k8sProvisioner.js";

type Container = {
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
};
type Manifest = { spec: { podTemplate: { spec: { containers: Container[] } } } };

const render = (deploy: Record<string, unknown>) =>
  sandboxManifest("abc", "conv-abc", "sandbox-abc", "img:latest", "ns", "aud", "10Gi", true, deploy) as Manifest;

describe("sandboxManifest resource requests/limits", () => {
  it("applies the passed resources to the sandbox container", () => {
    // The Guaranteed-QoS profile: requests equal limits on cpu and memory.
    const resources = { requests: { cpu: "2", memory: "4Gi" }, limits: { cpu: "2", memory: "4Gi" } };
    const c = render({ resources }).spec.podTemplate.spec.containers[0];
    expect(c.resources).toEqual(resources);
    // A cpu limit is emitted so a runaway pod is throttled.
    expect(c.resources?.limits?.cpu).toBe("2");
  });

  it("emits NO resources block when none are configured", () => {
    const c = render({}).spec.podTemplate.spec.containers[0];
    expect(c.resources).toBeUndefined();
  });
});
