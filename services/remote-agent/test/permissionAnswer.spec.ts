/**
 * Tier 1 contract for the container's ack handling, pinned against the frame the BYOC
 * controller actually emits (see byoc-controller runRelay.answerPermission) so the two
 * ends cannot drift apart silently.
 */

import { describe, it, expect } from "vitest";

import { parsePermissionAnswer } from "../src/permissionAnswer.js";

describe("container: parsing a permission answer from the controller", () => {
  it("reads the FLAT payload the controller actually sends", () => {
    // Byte-for-byte what runRelay.answerPermission puts on the wire.
    const frame = { ch: "acp" as const, type: "ack", id: "perm-1", payload: { optionId: "allow" } };
    expect(parsePermissionAnswer(frame.payload)).toEqual({ optionId: "allow" });
  });

  it("reads a cancellation", () => {
    expect(parsePermissionAnswer({ cancelled: true })).toEqual({ cancelled: true });
  });

  it("still accepts the LEGACY nested shape (a container may outlive a controller rollout)", () => {
    // The container is not redeployed in lockstep with the cloud, so a rollout in either order must not break approvals.
    expect(parsePermissionAnswer({ result: { optionId: "allow" } })).toEqual({ optionId: "allow" });
    expect(parsePermissionAnswer({ result: { cancelled: true } })).toEqual({ cancelled: true });
  });

  it("an EMPTY payload is a cancellation, never a silent approval", () => {
    // A malformed answer that fell through as a selection would let the tool call run without approval.
    expect(parsePermissionAnswer({})).toEqual({ cancelled: true });
    expect(parsePermissionAnswer(undefined)).toEqual({ cancelled: true });
    expect(parsePermissionAnswer(null)).toEqual({ cancelled: true });
  });

  it("an ERROR answer is a cancellation (the controller could not deliver the decision)", () => {
    expect(parsePermissionAnswer({ error: "unknown permission perm-1" })).toEqual({ cancelled: true });
  });

  it("an explicitly EMPTY optionId is a cancellation, not an approval", () => {
    // An empty option id selects nothing.
    expect(parsePermissionAnswer({ optionId: "" })).toEqual({ cancelled: true });
  });

  it("a non-string optionId is rejected rather than coerced", () => {
    expect(parsePermissionAnswer({ optionId: 42 })).toEqual({ cancelled: true });
  });
});
