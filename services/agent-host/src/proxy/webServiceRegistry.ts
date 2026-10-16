/**
 * WebServiceRegistry: reads a conversation's declared web services from the in-pod
 * discovery manifest (/run/scooter/web-services.json, rendered by the `webServices`
 * NixOS option) via the exec API and drives their systemd units. Descriptors are
 * cached per conversation with a short TTL so a `scooter-rebuild` shows up without a
 * restart; start drops the entry and list({force}) re-reads on demand. This module
 * owns the exec coupling so the proxy stays unit-testable against a fake registry.
 * Liveness is cached too, on a shorter TTL; only the loading page's poll asks for it.
 */

import type { SandboxRef } from "../types.js";
import type { WebServiceDescriptor, WebServiceRegistry } from "./webServiceProxy.js";

/** The manifest file the `webServices` option renders inside the pod. */
export const MANIFEST_PATH = "/run/scooter/web-services.json";

/** The exec surface needed here, a subset of SandboxApiClient. */
export interface ExecLike {
  execute(req: { command: string; args?: string[] }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  download(path: string): Promise<string>;
}

export interface WebServiceRegistryDeps {
  /** Resolve a conversation id to its sandbox ref. */
  sandboxFor(conversationId: string): SandboxRef | undefined;
  /** Connect an exec client for a sandbox. */
  connect(ref: SandboxRef): Promise<ExecLike>;
}

/** The manifest's optional `resources` block as a descriptor field, or `{}` when nothing usable is declared. */
function parseNeed(v: unknown): { resources?: { cpu?: string; memory?: string; gpu?: number } } {
  if (typeof v !== "object" || v === null) return {};
  const o = v as Record<string, unknown>;
  const need: { cpu?: string; memory?: string; gpu?: number } = {};
  if (typeof o.cpu === "string") need.cpu = o.cpu;
  if (typeof o.memory === "string") need.memory = o.memory;
  if (typeof o.gpu === "number") need.gpu = o.gpu;
  return Object.keys(need).length ? { resources: need } : {};
}

/** Parse the manifest JSON into descriptors, tolerating a missing/garbage file. */
export function parseManifest(json: string): WebServiceDescriptor[] {
  try {
    const data = JSON.parse(json) as { services?: unknown };
    if (!data || !Array.isArray(data.services)) return [];
    return data.services.flatMap((s): WebServiceDescriptor[] => {
      if (typeof s !== "object" || s === null) return [];
      const o = s as Record<string, unknown>;
      if (typeof o.name !== "string" || typeof o.port !== "number") return [];
      return [{
        name: o.name,
        displayName: typeof o.displayName === "string" ? o.displayName : o.name,
        port: o.port,
        basePath: typeof o.basePath === "string" ? o.basePath : `/c/*/${o.name}`,
        unit: typeof o.unit === "string" ? o.unit : `webservice-${o.name}`,
        stripBasePath: o.stripBasePath === true,
        ...parseNeed(o.resources),
      }];
    });
  } catch {
    return [];
  }
}

/** How long a successful manifest read stays authoritative, since nothing in the pod signals a `scooter-rebuild`. */
export const MANIFEST_TTL_MS = 10_000;

/** How long a liveness answer stays authoritative: short enough that a unit coming up
    shows promptly, long enough that a 1s poll is not an exec per tick. Why: PR #791. */
export const RUNNING_TTL_MS = 2_000;

export function createWebServiceRegistry(
  deps: WebServiceRegistryDeps,
  opts: { ttlMs?: number; runningTtlMs?: number; now?: () => number } = {},
): WebServiceRegistry {
  const ttlMs = opts.ttlMs ?? MANIFEST_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  // conversationId -> descriptors plus when they were read.
  const cache = new Map<string, { descriptors: WebServiceDescriptor[]; at: number }>();
  // `${conversationId}\u0000${service}` -> liveness plus when it was read.
  const liveness = new Map<string, { value: boolean; at: number }>();
  const runningTtlMs = opts.runningTtlMs ?? RUNNING_TTL_MS;
  const livenessKey = (conversationId: string, name: string) => `${conversationId}\u0000${name}`;
  /** Forget what we knew about a conversation's units, by service or wholesale. */
  function forgetLiveness(conversationId: string, name?: string): void {
    if (name !== undefined) {
      liveness.delete(livenessKey(conversationId, name));
      return;
    }
    for (const key of liveness.keys()) {
      if (key.startsWith(`${conversationId}\u0000`)) liveness.delete(key);
    }
  }

  async function load(conversationId: string, force = false): Promise<WebServiceDescriptor[]> {
    const entry = cache.get(conversationId);
    const cached = !force && entry && now() - entry.at < ttlMs ? entry.descriptors : undefined;
    // Only a non-empty cached list is authoritative, since an empty one usually means
    // the manifest could not be read yet.
    if (cached && cached.length > 0) return cached;
    const ref = deps.sandboxFor(conversationId);
    if (!ref) return [];
    let descriptors: WebServiceDescriptor[] = [];
    try {
      const exec = await deps.connect(ref);
      descriptors = parseManifest(await exec.download(MANIFEST_PATH));
    } catch {
      descriptors = []; // pod asleep, creating, or manifest missing
    }
    if (descriptors.length > 0) cache.set(conversationId, { descriptors, at: now() });
    return descriptors;
  }

  async function unit(conversationId: string, name: string): Promise<string | null> {
    const desc = (await load(conversationId)).find((d) => d.name === name);
    return desc?.unit ?? null;
  }

  return {
    async list(conversationId, opts) {
      return load(conversationId, opts?.force ?? false);
    },
    async get(conversationId, name) {
      return (await load(conversationId)).find((d) => d.name === name) ?? null;
    },
    async isRunning(conversationId, name) {
      // One exec per TTL, not one per caller: the loading page polls this every second.
      const key = livenessKey(conversationId, name);
      const seen = liveness.get(key);
      if (seen && now() - seen.at < runningTtlMs) return seen.value;
      const u = await unit(conversationId, name);
      const ref = deps.sandboxFor(conversationId);
      if (!u || !ref) return false;
      let value = false;
      try {
        const exec = await deps.connect(ref);
        // `systemctl is-active` exits 0 and prints "active" when running.
        const r = await exec.execute({ command: "systemctl", args: ["is-active", u] });
        value = r.exitCode === 0 && r.stdout.trim() === "active";
      } catch {
        value = false;
      }
      liveness.set(key, { value, at: now() });
      return value;
    },
    async start(conversationId, name) {
      const u = await unit(conversationId, name);
      const ref = deps.sandboxFor(conversationId);
      if (!u || !ref) throw new Error(`no web service "${name}" for ${conversationId}`);
      const exec = await deps.connect(ref);
      // Through `scooter-service` so the enabled set is persisted to
      // /workspace/.scooter/services.json and the boot restore brings the service back
      // after a suspend/resume pod recreate.
      const r = await exec.execute({ command: "scooter-service", args: ["start", name] });
      if (r.exitCode !== 0) {
        throw new Error(`scooter-service start ${name} failed (${r.exitCode}): ${r.stderr.trim()}`);
      }
      // A start may reveal a freshly-enabled service, and a cached "down" would outlive
      // the unit it was told about, so both caches go.
      cache.delete(conversationId);
      forgetLiveness(conversationId, name);
    },
    async stop(conversationId, name) {
      const u = await unit(conversationId, name);
      const ref = deps.sandboxFor(conversationId);
      if (!u || !ref) throw new Error(`no web service "${name}" for ${conversationId}`);
      const exec = await deps.connect(ref);
      // Via `scooter-service stop` so autostart is cleared and the service stays down on the next resume.
      const r = await exec.execute({ command: "scooter-service", args: ["stop", name] });
      if (r.exitCode !== 0) {
        throw new Error(`scooter-service stop ${name} failed (${r.exitCode}): ${r.stderr.trim()}`);
      }
      forgetLiveness(conversationId, name);
    },
    async logs(conversationId, name, lines = 50) {
      const u = await unit(conversationId, name);
      const ref = deps.sandboxFor(conversationId);
      if (!u || !ref) return "";
      try {
        const exec = await deps.connect(ref);
        // A never-started unit journals nothing; stderr is merged in case journalctl warns but still prints.
        const r = await exec.execute({
          command: "journalctl",
          args: ["-u", u, "-n", String(lines), "--no-pager", "--no-hostname"],
        });
        return (r.stdout || r.stderr || "").trim();
      } catch {
        return ""; // pod asleep, creating, or journalctl unavailable
      }
    },
    async ready(conversationId) {
      const ref = deps.sandboxFor(conversationId);
      if (!ref) return false;
      try {
        // Readiness means the exec channel is live: download() succeeds only once the pod is Running and Ready.
        const exec = await deps.connect(ref);
        await exec.download(MANIFEST_PATH);
        return true;
      } catch {
        return false; // pod creating, asleep, or unreachable
      }
    },
    invalidate(conversationId) {
      cache.delete(conversationId);
      forgetLiveness(conversationId);
    },
  };
}
