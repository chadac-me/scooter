/**
 * ModuleRegistry: the agent-host's view of a conversation's attached registry
 * modules, reached only via the exec API and the in-pod scooter-* CLIs. Search execs
 * `agent-broker "modules?q=<q>"`, list reads `/etc/scooter/registry-modules.json`,
 * and install execs `scooter-rebuild module add <ref>`. Everything needs a running
 * pod: when it is asleep the list is empty and install throws.
 */

import type { SandboxRef } from "../types.js";
import type { ExecLike } from "./webServiceRegistry.js";

/** The file scooter-rebuild keeps the attached registry-module names in. */
export const REGISTRY_IDS_PATH = "/etc/scooter/registry-modules.json";

/** One module as the broker registry returns it (GET /modules). */
export interface RegistryModule {
  id: number;
  name: string;
  description: string;
  visibility: "public" | "private";
  /** The publishing conversation id, omitted for the caller's own. */
  owner?: string;
}

export interface ModuleRegistryDeps {
  sandboxFor(conversationId: string): SandboxRef | undefined;
  connect(ref: SandboxRef): Promise<ExecLike>;
}

export interface ModuleRegistry {
  /** Search the broker catalog (caller's own plus all public); an empty query means all. */
  search(conversationId: string, query: string): Promise<RegistryModule[]>;
  /** The names of the registry modules currently attached to this conversation. */
  attached(conversationId: string): Promise<string[]>;
  /** Attach a registry module by name-or-id and re-converge, returning the CLI's message or throwing on failure. */
  install(conversationId: string, ref: string): Promise<string>;
}

/** Parse the broker `GET /modules` JSON body, tolerating garbage. */
export function parseModuleList(json: string): RegistryModule[] {
  try {
    const data = JSON.parse(json) as { modules?: unknown };
    if (!data || !Array.isArray(data.modules)) return [];
    return data.modules.flatMap((m): RegistryModule[] => {
      if (typeof m !== "object" || m === null) return [];
      const o = m as Record<string, unknown>;
      if (typeof o.name !== "string" || typeof o.id !== "number") return [];
      return [{
        id: o.id,
        name: o.name,
        description: typeof o.description === "string" ? o.description : "",
        visibility: o.visibility === "private" ? "private" : "public",
        owner: typeof o.owner === "string" ? o.owner : undefined,
      }];
    });
  } catch {
    return [];
  }
}

export function createModuleRegistry(deps: ModuleRegistryDeps): ModuleRegistry {
  const connect = async (conversationId: string): Promise<ExecLike | null> => {
    const ref = deps.sandboxFor(conversationId);
    if (!ref) return null;
    try {
      return await deps.connect(ref);
    } catch {
      return null; // pod asleep or unreachable
    }
  };

  return {
    async search(conversationId, query) {
      const exec = await connect(conversationId);
      if (!exec) return [];
      try {
        // agent-broker is the authenticated broker wrapper baked into the pod.
        const r = await exec.execute({ command: "agent-broker", args: [`modules?q=${encodeURIComponent(query)}`] });
        if (r.exitCode !== 0) return [];
        return parseModuleList(r.stdout);
      } catch {
        return [];
      }
    },

    async attached(conversationId) {
      const exec = await connect(conversationId);
      if (!exec) return [];
      try {
        const raw = await exec.download(REGISTRY_IDS_PATH);
        const arr = JSON.parse(raw) as unknown;
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return []; // no attached modules, or pod asleep
      }
    },

    async install(conversationId, ref) {
      const exec = await connect(conversationId);
      if (!exec) throw new Error("sandbox isn't running — start it, then install the module");
      const r = await exec.execute({ command: "scooter-rebuild", args: ["module", "add", ref] });
      if (r.exitCode !== 0) {
        throw new Error(`install failed (${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
      }
      return (r.stdout || `attached ${ref}`).trim();
    },
  };
}
