/** A rejected k8s exec becomes an Error whose message carries the Status, never `[object Object]`. */

import { describe, it, expect } from "vitest";

import { K8sExecError, toExecError } from "../../src/exec/k8sExec.js";

describe("toExecError", () => {
  it("serializes a bare k8s Status", () => {
    const e = toExecError({
      kind: "Status",
      status: "Failure",
      reason: "NotFound",
      message: 'pods "conv-abc" not found',
      code: 404,
    });
    expect(e).toBeInstanceOf(K8sExecError);
    expect(e.message).toBe('k8s exec failed: NotFound: pods "conv-abc" not found (code 404)');
    expect(e.status?.code).toBe(404);
    expect(String(e)).not.toContain("[object Object]");
  });

  it("reads the Status out of an ApiException body, JSON or parsed", () => {
    const body = { kind: "Status", status: "Failure", reason: "Forbidden", message: "nope", code: 403 };
    expect(toExecError({ body: JSON.stringify(body) }).message).toContain("Forbidden: nope (code 403)");
    expect(toExecError(Object.assign(new Error("HTTP 403"), { body })).message).toContain("Forbidden: nope");
  });

  it("unwraps a ws ErrorEvent and keeps the close frame", () => {
    const e = toExecError({ error: new Error("socket hang up") }, { code: 1006, reason: "" });
    expect(e.message).toBe("k8s exec failed: socket hang up (ws close 1006)");
  });

  it("never prints [object Object] for an opaque value", () => {
    expect(toExecError({ weird: { nested: 1 } }).message).toBe('k8s exec failed: {"weird":{"nested":1}}');
    expect(toExecError({}).message).toBe("k8s exec failed: no error detail");
  });
});
