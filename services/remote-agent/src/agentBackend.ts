/** The agent a container drives, chosen by name; every backend returns an AcpClient. */
import type { AcpClient } from "@scooter/claude-sdk-provider";

/** Backend inputs; oauthToken is Claude-specific. */
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
  /** Needs a Claude subscription token; login is skipped when false. */
  readonly needsClaudeAuth: boolean;
  create(deps: AgentBackendDeps): Promise<AcpClient>;
}

/** The default: the user's own Claude subscription via the SDK. */
const claudeBackend: AgentBackend = {
  id: "claude",
  needsClaudeAuth: true,
  async create(deps) {
    // Lazy: another backend loads no SDK.
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

/** Register a backend; echo self-registers. */
export function registerBackend(b: AgentBackend): void {
  BACKENDS[b.id] = b;
}

/** The backend from --backend/SCOOTER_AGENT_BACKEND; default claude. */
export function selectBackend(name?: string): AgentBackend {
  const id = (name ?? process.env.SCOOTER_AGENT_BACKEND ?? "claude").trim();
  const b = BACKENDS[id];
  if (!b) throw new Error(`unknown agent backend "${id}" (have: ${Object.keys(BACKENDS).join(", ")})`);
  return b;
}
