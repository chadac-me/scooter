/**
 * The OwnershipGuard fencing core, the multi-replica guard that stops a reassigned pod
 * from appending to a conversation the new owner drives. The row feed (pgOwnershipGuard) feeds observe().
 */
import { describe, it, expect } from "vitest";

import { OwnershipTracker, allowAllGuard } from "../../src/session/ownershipGuard.js";
import type { SessionId } from "../../src/types.js";

const C = "conv-1" as SessionId;

describe("allowAllGuard (fencing disabled)", () => {
  it("always allows (single-replica default is a no-op)", () => {
    expect(allowAllGuard.canWrite(C)).toBe(true);
  });
});

describe("OwnershipTracker", () => {
  it("fails OPEN for an unobserved conversation (no row yet)", () => {
    const t = new OwnershipTracker("agent-host-0");
    expect(t.canWrite(C)).toBe(true);
  });

  it("allows when THIS pod is the host", () => {
    const t = new OwnershipTracker("agent-host-0");
    t.observe("conv-1", { hostPod: "agent-host-0", generation: 1 });
    expect(t.canWrite(C)).toBe(true);
  });

  it("REFUSES when another pod is the host", () => {
    const t = new OwnershipTracker("agent-host-0");
    t.observe("conv-1", { hostPod: "agent-host-1", generation: 1 });
    expect(t.canWrite(C)).toBe(false);
  });

  it("refuses after being REASSIGNED away (the fencing case)", () => {
    const t = new OwnershipTracker("agent-host-0");
    t.observe("conv-1", { hostPod: "agent-host-0", generation: 1 });
    expect(t.canWrite(C)).toBe(true);
    t.observe("conv-1", { hostPod: "agent-host-1", generation: 2 });
    expect(t.canWrite(C)).toBe(false);
  });

  it("allows again if reassigned BACK to this pod (gen advances)", () => {
    const t = new OwnershipTracker("agent-host-0");
    t.observe("conv-1", { hostPod: "agent-host-1", generation: 2 });
    expect(t.canWrite(C)).toBe(false);
    t.observe("conv-1", { hostPod: "agent-host-0", generation: 3 });
    expect(t.canWrite(C)).toBe(true);
  });

  it("treats a DELETED row (null) as unobserved -> fail open", () => {
    const t = new OwnershipTracker("agent-host-0");
    t.observe("conv-1", { hostPod: "agent-host-1", generation: 1 });
    expect(t.canWrite(C)).toBe(false);
    t.observe("conv-1", null);
    expect(t.canWrite(C)).toBe(true);
  });
});

describe("OwnershipTracker.owns — positive ownership only", () => {
  it("is false for unobserved, deleted and other-pod conversations; true only for ours", () => {
    const t = new OwnershipTracker("host-a");
    expect(t.owns("c" as never)).toBe(false); // unobserved: canWrite fails open, owns does not
    expect(t.canWrite("c" as never)).toBe(true);
    t.observe("c", { hostPod: "host-a", generation: 1 });
    expect(t.owns("c" as never)).toBe(true);
    t.observe("c", { hostPod: "host-b", generation: 2 });
    expect(t.owns("c" as never)).toBe(false);
    t.observe("c", null); // deleted
    expect(t.owns("c" as never)).toBe(false);
    expect(t.canWrite("c" as never)).toBe(true);
  });
});
