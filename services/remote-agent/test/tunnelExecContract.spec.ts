/**
 * Tier 1: the tunnel ExecBackend satisfies the contract the SDK's tools actually use,
 * driving the bash tool's spawn -> waitForExit -> release sequence.
 */

import { describe, it, expect } from "vitest";

import { createTunnelExecBackend } from "../src/tunnelExec.js";
import type { WireFrame } from "../src/protocol.js";

function backendWithCloud(result: { exitCode: number; stdout: string; stderr?: string }) {
  let onFrame: ((f: WireFrame) => void) | undefined;
  const backend = createTunnelExecBackend({
    send: (f) => {
      // The cloud answers every exec_run with `result`, as the relay would.
      setTimeout(() => onFrame?.({ ch: "exec", type: "exec_result", id: f.id, payload: { result } }), 0);
    },
    onFrame: (cb) => {
      onFrame = cb;
      return () => (onFrame = undefined);
    },
  });
  return backend;
}

describe("tunnel ExecBackend contract", () => {
  it("THE FAILING SEQUENCE: spawn -> waitForExit -> release (the bash tool's exact calls)", async () => {
    const backend = backendWithCloud({ exitCode: 0, stdout: "hi\n" });
    const handle = backend.spawn({ command: "sh", args: ["-lc", "echo hi"], cwd: "/workspace", env: {} });
    let out = "";
    handle.onOutput((c) => (out += c));
    const { exitCode } = await handle.waitForExit();
    await handle.release();
    expect(exitCode).toBe(0);
    expect(out).toContain("hi");
  });

  it("kill() also resolves (the other optional-looking-but-required method)", async () => {
    const backend = backendWithCloud({ exitCode: 0, stdout: "" });
    const handle = backend.spawn({ command: "sh", args: ["-lc", "sleep 1"], cwd: "/workspace", env: {} });
    await expect(handle.kill()).resolves.toBeUndefined();
  });
});
