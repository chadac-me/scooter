import type { SandboxProvisioner, SessionManager } from "./manager.js";
import type { SandboxRef, SessionId } from "../types.js";

/**
 * The exec layer's resume-on-missing-pod hook, fenced by end().
 *
 * A conversation end() tore down must stay down. An exec still polling for its pod when the
 * DELETE lands finds no pod and fires ensureRunning; a bare provisioner.resume() then 404s on the
 * deleted Sandbox and recreates it, leaking a pod (and its CPU request) until the controller's
 * orphan reap ~10 min later. The error carries code 404 so pollForReadyPod fails at once instead
 * of polling to its deadline.
 */
export function resumeUnlessEnded(
  sessions: Pick<SessionManager, "isEnded">,
  provisioner: Pick<SandboxProvisioner, "resume">,
  id: SessionId,
  sandbox: SandboxRef,
): () => Promise<void> {
  return async () => {
    if (sessions.isEnded?.(id)) {
      throw Object.assign(new Error(`conversation was ended: ${id}; not recreating its sandbox`), { code: 404 });
    }
    await provisioner.resume(sandbox);
  };
}
