/** Skill providers: sandbox commands or broker paths that hand a conversation extra skills. */

import { formatError, logger } from "../log.js";

import type { BrokerAsConversation } from "./brokerAsConversation.js";
import type { ProvidedSkillFile } from "./skills.js";
import type { ExecRequest, ExecResult, SandboxRef } from "../types.js";

const log = logger("skill-providers");

/** One row of SKILL_PROVIDERS_JSON. */
export interface SkillProviderDef {
  id: string;
  /** Bash script run in the sandbox; prints `{"skills": [...]}`. Unset when `broker` is set. */
  command?: string;
  /** Broker path the agent-host GETs as the conversation instead, answering the same: no sandbox needed. */
  broker?: string;
  /** Seconds before the command is killed. */
  timeoutSec: number;
  /** Seconds a message waits for it; a slower answer lands later. */
  waitSec: number;
  description: string;
}

/** Re-run a provider at most this often per conversation. */
export const PROVIDER_TTL_MS = 10_000;

/** SKILL_PROVIDERS_JSON's well-formed rows. */
export function parseSkillProviders(raw: string | undefined, warn?: (msg: string) => void): SkillProviderDef[] {
  if (!raw || !raw.trim()) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    warn?.("SKILL_PROVIDERS_JSON is not valid JSON; no skill providers will run");
    return [];
  }
  if (!Array.isArray(doc)) return [];
  const pos = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : d);
  return (doc as Array<Partial<SkillProviderDef> | null>).flatMap((r): SkillProviderDef[] => {
    if (typeof r?.id !== "string" || !r.id || nonBlank(r.command) === nonBlank(r.broker)) {
      warn?.(`SKILL_PROVIDERS_JSON: dropping malformed provider ${JSON.stringify(r?.id ?? null)}`);
      return [];
    }
    const timeoutSec = pos(r.timeoutSec, 30);
    return [{
      id: r.id,
      ...(nonBlank(r.command) ? { command: r.command } : { broker: (r.broker as string).trim() }),
      timeoutSec,
      waitSec: Math.min(pos(r.waitSec, timeoutSec), timeoutSec),
      description: typeof r.description === "string" ? r.description : "",
    }];
  });
}

/** A provider names exactly one of a sandbox `command` and a `broker` path. */
const nonBlank = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

/** Parse a provider's stdout, keeping only well-formed skills. */
export function parseProvidedSkills(json: string): ProvidedSkillFile[] {
  const data = JSON.parse(json) as { skills?: unknown };
  if (!data || !Array.isArray(data.skills)) throw new Error('expected {"skills": [...]}');
  return data.skills.flatMap((s): ProvidedSkillFile[] => {
    if (typeof s !== "object" || s === null) return [];
    const o = s as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.content !== "string") return [];
    return [{ name: o.name, content: o.content, ...(typeof o.dir === "string" && o.dir ? { dir: o.dir } : {}) }];
  });
}

/** The exec surface needed here, a subset of SandboxApiClient. */
export interface ProviderExec {
  execute(req: Pick<ExecRequest, "command" | "args" | "stdin" | "cwd" | "env">, signal?: AbortSignal): Promise<ExecResult>;
}

export interface SkillProviderRegistryDeps {
  providers: readonly SkillProviderDef[];
  sandboxFor(conversationId: string): SandboxRef | undefined;
  connect(ref: SandboxRef): Promise<ProviderExec>;
  /** Calls the broker as the conversation, for `broker` providers. */
  broker?: BrokerAsConversation;
}

export interface SkillProviderRegistry {
  /** Every provider's skills, in provider-id order; never throws. */
  skills(conversationId: string, owner?: string): Promise<ProvidedSkillFile[]>;
}

interface ProviderState {
  running?: Promise<void>;
  cache?: { files: ProvidedSkillFile[]; at: number };
  /** The sandbox lacks the provider's command; stop asking it. */
  unsupported?: boolean;
}

/** Shell exit status for command not found. */
const NOT_FOUND = 127;

export function createSkillProviderRegistry(
  deps: SkillProviderRegistryDeps,
  opts: { ttlMs?: number; now?: () => number } = {},
): SkillProviderRegistry {
  const ttlMs = opts.ttlMs ?? PROVIDER_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const providers = [...deps.providers].sort((a, b) => a.id.localeCompare(b.id));
  const state = new Map<string, ProviderState>();
  const stateFor = (key: string) => {
    let st = state.get(key);
    if (!st) state.set(key, (st = {}));
    return st;
  };

  async function run(p: SkillProviderDef, conversationId: string, owner: string | undefined, st: ProviderState) {
    if (p.broker) {
      if (!deps.broker) throw new Error("broker skill providers are not available here (no BROKER_URL)");
      const res = await deps.broker(conversationId, p.broker, {
        method: "GET",
        signal: AbortSignal.timeout(p.timeoutSec * 1000),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`broker ${p.broker}: HTTP ${res.status} ${res.body.slice(0, 500)}`);
      }
      st.cache = { files: parseProvidedSkills(res.body), at: now() };
      return;
    }
    const ref = deps.sandboxFor(conversationId);
    if (!ref) throw new Error(`no sandbox for conversation ${conversationId}`);
    const exec = await deps.connect(ref);
    const r = await exec.execute(
      {
        command: "bash",
        args: ["-c", p.command!],
        cwd: "/workspace",
        env: { SCOOTER_SKILL_PROVIDER: p.id },
        stdin: JSON.stringify({ conversation_id: conversationId, owner: owner ?? null }),
      },
      AbortSignal.timeout(p.timeoutSec * 1000),
    );
    if (r.exitCode === NOT_FOUND) {
      st.unsupported = true;
      log.info("skill provider's command is missing in this sandbox; skipping it", {
        conversation_id: conversationId,
        provider: p.id,
      });
      return;
    }
    if (r.exitCode !== 0) throw new Error(`exited ${r.exitCode}: ${r.stderr.trim().slice(-500)}`);
    st.cache = { files: parseProvidedSkills(r.stdout), at: now() };
  }

  async function one(p: SkillProviderDef, conversationId: string, owner?: string): Promise<ProvidedSkillFile[]> {
    const st = stateFor(`${conversationId}\0${p.id}`);
    if (st.unsupported) return [];
    if (st.cache && now() - st.cache.at < ttlMs) return st.cache.files;
    st.running ??= run(p, conversationId, owner, st)
      .catch((err) => {
        // A blip must not read as "no skills".
        log.warn("skill provider failed; keeping its last answer", {
          conversation_id: conversationId,
          provider: p.id,
          error: formatError(err),
        });
      })
      .finally(() => {
        st.running = undefined;
      });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      st.running,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, p.waitSec * 1000);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    return st.cache?.files ?? [];
  }

  return {
    async skills(conversationId, owner) {
      // A broker provider needs no sandbox, so it answers while the pod is still starting.
      const live = deps.sandboxFor(conversationId) ? providers : providers.filter((p) => p.broker);
      if (!live.length) return [];
      const answers = await Promise.all(live.map((p) => one(p, conversationId, owner)));
      return answers.flat();
    },
  };
}
