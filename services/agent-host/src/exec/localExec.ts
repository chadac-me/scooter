/**
 * Local exec backend for fake mode: implements the SandboxApiClient seam with local
 * subprocesses so the fake agent's real tool calls exercise the full chain without
 * a sandbox pod.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

import type { ExecRequest, ExecResult } from "../types.js";
import type { SandboxApiClient } from "./sandboxExec.js";

export function createLocalSandboxApiClient(): SandboxApiClient {
  const files = new Map<string, string>();

  const run = (req: ExecRequest, signal?: AbortSignal): Promise<ExecResult> =>
    new Promise((resolve) => {
      // The sandbox's /workspace does not exist locally, so fall back to a real writable dir.
      const cwd = req.cwd && existsSync(req.cwd) ? req.cwd : tmpdir();
      if (signal?.aborted) {
        resolve({ stdout: "", stderr: "aborted", exitCode: 130 });
        return;
      }
      const child = spawn(req.command, req.args, {
        cwd,
        env: { ...process.env, ...req.env },
        shell: false,
      });
      // Cancel kills the child with SIGTERM, then SIGKILL if it lingers.
      const onAbort = () => {
        child.kill("SIGTERM");
        setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 500);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode: signal?.aborted ? 130 : (code ?? 0) });
      });
      child.on("error", (e) => resolve({ stdout, stderr: String(e), exitCode: 127 }));
    });

  return {
    mode: "direct",
    execute: (req, signal) => run(req, signal),
    async download(path) {
      const c = files.get(path);
      if (c === undefined) throw new Error(`no such file: ${path}`);
      return c;
    },
    async upload(path, content) {
      files.set(path, content);
    },
    async uploadBinary(path, base64) {
      // Decode and store so a later download round-trips the bytes.
      files.set(path, Buffer.from(base64, "base64").toString("binary"));
    },
  };
}
