/**
 * The Sandbox/SA delete-error policy: destroy() ignores a 404 and propagates every
 * other delete error, since swallowing one leaks the Sandbox or the ServiceAccount.
 */

import { describe, it, expect } from "vitest";

import { ignoreDeleteNotFound } from "../../src/session/k8sProvisioner.js";

describe("ignoreDeleteNotFound (destroy delete-error policy)", () => {
  it("swallows a 404 (already gone)", () => {
    expect(() => ignoreDeleteNotFound({ code: 404 })).not.toThrow();
  });

  it("rethrows a 403 (forbidden — delete did NOT happen, would leak)", () => {
    expect(() => ignoreDeleteNotFound({ code: 403 })).toThrow();
  });

  it("rethrows a 500 / transient error", () => {
    expect(() => ignoreDeleteNotFound({ code: 500 })).toThrow();
  });

  it("rethrows an error with no code (network/timeout)", () => {
    expect(() => ignoreDeleteNotFound({} as { code?: number })).toThrow();
  });
});
