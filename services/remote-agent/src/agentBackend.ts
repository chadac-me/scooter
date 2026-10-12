/**
 * The agent a container drives, chosen by name.
 *
 * `createSdkAcpClient` was called at one site with a hardcoded Claude SDK, so the
 * container could not run without a Claude subscription token — which left the
 * TUNNELLED MCP path (container -> controller -> agent-host -> broker) with no test
 * coverage, in either the VM tier or the cluster tier. Every backend returns the same
 * AcpClient the cloud already speaks, so another provider is a new entry here rather
 * than a fork of remoteAgentClient.
 */
import type { AcpClient } from "@scooter/claude-sdk-provider";

/** What a backend needs; `oauthToken` is Claude-specific and absent for others. */
export interface AgentBackendDeps {
  model?: string;
  mcpServers?: Array<{ name: string; url: string }>;
  exec: unknown;
  systemPrompt?: string;
  oauthToken?: string;
  claudeCodePath?: string;
  cwd?: string;
  settingSources?: ReadonlyArray<"project">;
  skills?: "all";
  log?: (msg: string) => void;
}

export interface AgentBackend {
  readonly id: string;
  /** True when this backend needs a Claude subscription token, so login is skipped otherwise. */
  readonly needsClaudeAuth: boolean;
  create(deps: AgentBackendDeps): Promise<AcpClient>;
}

/** The default: the user's own Claude subscription via the SDK. */
const claudeBackend: AgentBackend = {
  id: "claude",
  needsClaudeAuth: true,
  async create(deps) {
    // Lazy, so selecting another backend does not load the SDK.
    const { createSdkAcpClient } = await import("@scooter/claude-sdk-provider");
    return createSdkAcpClient({
      oauthToken: deps.oauthToken ?? "",
      mcpServers: deps.mcpServers,
      model: deps.model ?? "claude-sonnet-4-5",
      exec: deps.exec as never,
      systemPrompt: deps.systemPrompt ?? "You are Scooter, a helpful agent.",
      claudeCodePath: deps.claudeCodePath,
      ...(deps.cwd
        ? { cwd: deps.cwd, settingSources: ["project" as const], skills: "all" as const }
        : {}),
    } as never);
  },
};

export const BACKENDS: Record<string, AgentBackend> = { claude: claudeBackend };

/** Register a backend; `echo` adds itself so this module needs no test-only import. */
export function registerBackend(b: AgentBackend): void {
  BACKENDS[b.id] = b;
}

/** The backend named by `--backend`/SCOOTER_AGENT_BACKEND, defaulting to claude. */
export function selectBackend(name?: string): AgentBackend {
  const id = (name ?? process.env.SCOOTER_AGENT_BACKEND ?? "claude").trim();
  const b = BACKENDS[id];
  if (!b) throw new Error(`unknown agent backend "${id}" (have: ${Object.keys(BACKENDS).join(", ")})`);
  return b;
}
