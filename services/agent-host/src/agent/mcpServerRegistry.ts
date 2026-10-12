/**
 * McpServerRegistry: reads a conversation's declared MCP servers from the in-pod
 * discovery manifest (/run/scooter/mcp-servers.json, rendered by the `mcpServers`
 * NixOS option) via the exec API and drives their systemd units through
 * `scooter-mcp`, plus the pure resolver that turns descriptors into `new_session`
 * entries. A server that is not running is not offered, since a dead MCP endpoint
 * degrades the whole session, and the offered set carries a fingerprint so the
 * bridge can tell whether a rebuild changed anything.
 */

import { formatError, logger } from "../log.js";

import type { SandboxRef } from "../types.js";

const log = logger("mcp-registry");

/** The manifest file the `mcpServers` option renders inside the pod. */
export const MCP_MANIFEST_PATH = "/run/scooter/mcp-servers.json";

/** The name of the agent-host's own in-process MCP endpoint, which a sandbox-declared server may not take. */
export const RESERVED_NAMES = new Set(["scooter-env"]);

/** Prefix for sandbox-declared servers, matching the reservation in acp/tunnelTargets.ts. */
export const SANDBOX_PREFIX = "sandbox:";

export interface McpServerDescriptor {
  name: string;
  displayName: string;
  description: string;
  port: number;
  path: string;
  unit: string;
  autoStart: boolean;
  listenAddress: string;
}

/** An HTTP header on an offered MCP server, per the ACP schema's `HttpHeader`. */
export interface McpHeader {
  name: string;
  value: string;
}

/** An entry as `new_session`'s mcpServers takes it. */
export interface OfferedMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: McpHeader[];
}

/** The exec surface needed here, a subset of SandboxApiClient. */
export interface ExecLike {
  execute(req: { command: string; args?: string[] }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  download(path: string): Promise<string>;
}

export interface McpServerRegistryDeps {
  sandboxFor(conversationId: string): SandboxRef | undefined;
  connect(ref: SandboxRef): Promise<ExecLike>;
}

export interface McpServerRegistry {
  list(conversationId: string, opts?: { force?: boolean }): Promise<McpServerDescriptor[]>;
  get(conversationId: string, name: string): Promise<McpServerDescriptor | null>;
  isRunning(conversationId: string, name: string): Promise<boolean>;
  /** Start it if it is not already up; false means no such server or the start failed. */
  ensureStarted(conversationId: string, name: string): Promise<boolean>;
  invalidate(conversationId: string): void;
}

/** Parse the manifest, tolerating a missing or garbage file; `name` and `port` are required and everything else defaults. */
export function parseMcpManifest(json: string): McpServerDescriptor[] {
  try {
    const data = JSON.parse(json) as { servers?: unknown };
    if (!data || !Array.isArray(data.servers)) return [];
    return data.servers.flatMap((s): McpServerDescriptor[] => {
      if (typeof s !== "object" || s === null) return [];
      const o = s as Record<string, unknown>;
      if (typeof o.name !== "string" || typeof o.port !== "number") return [];
      return [{
        name: o.name,
        displayName: typeof o.displayName === "string" ? o.displayName : o.name,
        description: typeof o.description === "string" ? o.description : "",
        port: o.port,
        path: typeof o.path === "string" ? o.path : "/mcp",
        unit: typeof o.unit === "string" ? o.unit : `mcp-${o.name}`,
        autoStart: o.autoStart !== false,
        listenAddress: typeof o.listenAddress === "string" ? o.listenAddress : "127.0.0.1",
      }];
    });
  } catch {
    return [];
  }
}

/** How long a successful manifest read stays authoritative, since nothing in the pod signals a `scooter-rebuild`. */
export const MCP_MANIFEST_TTL_MS = 10_000;

/** The servers to offer a session, namespaced under `sandbox:` so none can shadow scooter-env and sorted by name so a reorder is not a fingerprint change. */
export function offeredMcpServers(
  descriptors: McpServerDescriptor[],
  urlFor: (d: McpServerDescriptor) => string,
): OfferedMcpServer[] {
  return descriptors
    .filter((d) => !RESERVED_NAMES.has(d.name))
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((d) => ({
      type: "http" as const,
      name: `${SANDBOX_PREFIX}${d.name}`,
      url: urlFor(d),
      headers: [],
    }));
}

/** A stable identity for the offered set, which the bridge compares across runs to decide whether to rebuild the agent session; it covers names, URLs and header names only, never header values, since a freshly minted token differs on every mint. */
export function fingerprintOffered(offered: OfferedMcpServer[]): string {
  return JSON.stringify(offered.map((o) => [o.name, o.url, o.headers.map((h) => h.name)]));
}

export function createMcpServerRegistry(
  deps: McpServerRegistryDeps,
  opts: { ttlMs?: number; now?: () => number } = {},
): McpServerRegistry {
  const ttlMs = opts.ttlMs ?? MCP_MANIFEST_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, { descriptors: McpServerDescriptor[]; at: number }>();

  async function load(conversationId: string, force = false): Promise<McpServerDescriptor[]> {
    const entry = cache.get(conversationId);
    const cached = !force && entry && now() - entry.at < ttlMs ? entry.descriptors : undefined;
    // Only a non-empty cached list is authoritative, since an empty one usually means
    // the pod could not be read yet.
    if (cached && cached.length > 0) return cached;
    const ref = deps.sandboxFor(conversationId);
    if (!ref) return [];
    let descriptors: McpServerDescriptor[] = [];
    try {
      const exec = await deps.connect(ref);
      const raw = await exec.download(MCP_MANIFEST_PATH);
      descriptors = parseMcpManifest(raw);
      // A manifest that was read but parsed to nothing is a different problem from an
      // absent one, with the same user-visible symptom.
      if (raw.trim() !== "" && descriptors.length === 0) {
        log.warn("the MCP manifest parsed to no servers; check the rendered file", {
          conversation_id: conversationId,
          path: MCP_MANIFEST_PATH,
          bytes: raw.length,
        });
      }
    } catch (err) {
      // An unreadable manifest and no declared servers both surface as an empty list, so log which.
      log.warn("could not read the MCP manifest; offering no sandbox servers this time", {
        conversation_id: conversationId,
        path: MCP_MANIFEST_PATH,
        error: formatError(err),
      });
      descriptors = [];
    }
    if (descriptors.length > 0) cache.set(conversationId, { descriptors, at: now() });
    return descriptors;
  }

  async function execFor(conversationId: string): Promise<ExecLike | null> {
    const ref = deps.sandboxFor(conversationId);
    if (!ref) return null;
    try {
      return await deps.connect(ref);
    } catch {
      return null;
    }
  }

  const registry: McpServerRegistry = {
    async list(conversationId, listOpts) {
      return load(conversationId, listOpts?.force ?? false);
    },
    async get(conversationId, name) {
      return (await load(conversationId)).find((d) => d.name === name) ?? null;
    },
    async isRunning(conversationId, name) {
      const desc = await registry.get(conversationId, name);
      const exec = await execFor(conversationId);
      if (!desc || !exec) return false;
      try {
        const r = await exec.execute({ command: "systemctl", args: ["is-active", desc.unit] });
        return r.exitCode === 0 && r.stdout.trim() === "active";
      } catch {
        return false;
      }
    },
    async ensureStarted(conversationId, name) {
      const desc = await registry.get(conversationId, name);
      if (!desc) return false;
      if (await registry.isRunning(conversationId, name)) return true;
      const exec = await execFor(conversationId);
      if (!exec) return false;
      // Through `scooter-mcp` so the autostart intent is persisted to the workspace PVC
      // and survives a suspend/resume pod recreate.
      try {
        const r = await exec.execute({ command: "scooter-mcp", args: ["start", name] });
        if (r.exitCode !== 0) {
          // The declared server will not be offered to the agent, so leave a trace.
          log.warn("scooter-mcp start failed; this server will not be offered", {
            conversation_id: conversationId,
            server: name,
            exit_code: r.exitCode,
            stderr: r.stderr.trim().slice(0, 500),
          });
        }
        return r.exitCode === 0;
      } catch (err) {
        log.warn("scooter-mcp start could not be executed; this server will not be offered", {
          conversation_id: conversationId,
          server: name,
          error: formatError(err),
        });
        return false;
      }
    },
    invalidate(conversationId) {
      cache.delete(conversationId);
    },
  };
  return registry;
}
