/**
 * Does a declared workload fit the sandbox it is about to run in? A web service's
 * declared resources are advisory: they never size the pod or block a start, and only
 * turn "my notebook died" into "marimo wants 8Gi, this sandbox is 4Gi". Needs are compared
 * against the sandbox's limits, the hard cap a workload is killed against. Every function
 * is total: an unparseable or absent quantity yields no shortfall rather than a guess.
 */

import type { SandboxResources } from "./resources.js";

/** What a workload says it needs; an omitted dimension means "no opinion", not zero. */
export interface ResourceNeed {
  cpu?: string;
  memory?: string;
  gpu?: number;
}

/** Binary (Ki/Mi/…) and decimal (K/M/…) multipliers, per the k8s quantity format. */
const MEMORY_UNITS: Record<string, number> = {
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
  K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
};

/** A k8s cpu quantity in millicores ("2" is 2000, "500m" is 500), or undefined if unparseable. */
export function cpuToMillicores(q: string | undefined): number | undefined {
  if (typeof q !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(q.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return m[2] === "m" ? n : n * 1000;
}

/** A k8s memory quantity in bytes ("1Gi", "512Mi", "2G", bare "1024"), or undefined if unparseable. */
export function memoryToBytes(q: string | undefined): number | undefined {
  if (typeof q !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/.exec(q.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return m[2] ? n * MEMORY_UNITS[m[2]] : n;
}

/** One dimension where the workload wants more than the sandbox has. */
export interface Shortfall {
  dimension: "cpu" | "memory" | "gpu";
  /** The declared requirement, as written. */
  need: string;
  /** What the sandbox actually caps at, as written. */
  have: string;
}

/**
 * The dimensions where `need` exceeds the sandbox's limits; empty means it fits or we could
 * not tell, and an uncapped dimension never produces a shortfall.
 */
export function shortfalls(need: ResourceNeed, have: SandboxResources | undefined): Shortfall[] {
  const limits = have?.limits;
  if (!limits) return [];
  const out: Shortfall[] = [];

  const needCpu = cpuToMillicores(need.cpu);
  const haveCpu = cpuToMillicores(limits.cpu);
  if (needCpu !== undefined && haveCpu !== undefined && needCpu > haveCpu) {
    out.push({ dimension: "cpu", need: need.cpu!, have: limits.cpu! });
  }

  const needMem = memoryToBytes(need.memory);
  const haveMem = memoryToBytes(limits.memory);
  if (needMem !== undefined && haveMem !== undefined && needMem > haveMem) {
    out.push({ dimension: "memory", need: need.memory!, have: limits.memory! });
  }

  // An absent gpu limit means zero GPUs, not unbounded, so any positive need is a shortfall.
  if (typeof need.gpu === "number" && need.gpu > 0) {
    const haveGpu = limits.gpu ?? 0;
    if (need.gpu > haveGpu) {
      out.push({ dimension: "gpu", need: `${need.gpu}`, have: `${haveGpu}` });
    }
  }

  return out;
}

/** The same gap in a few words for the Sandbox tab's service card, which pairs it with fitAdvice()
 *  as its tooltip. */
export function fitSummary(need: ResourceNeed, have: SandboxResources | undefined): string | undefined {
  const gaps = shortfalls(need, have);
  if (gaps.length === 0) return undefined;
  return `Needs ${gaps.map((g) => (g.dimension === "gpu" ? `${g.need} GPU` : `${g.need} ${g.dimension}`)).join(" + ")}`;
}

/** Human one-liner for a set of shortfalls, or undefined when it fits; the same sentence is shown
 *  to the agent and in the UI. */
export function fitAdvice(
  serviceName: string,
  need: ResourceNeed,
  have: SandboxResources | undefined,
): string | undefined {
  const gaps = shortfalls(need, have);
  if (gaps.length === 0) return undefined;
  const parts = gaps.map((g) =>
    g.dimension === "gpu"
      ? `${g.need} GPU (this sandbox has ${g.have})`
      : `${g.need} ${g.dimension} (this sandbox caps at ${g.have})`,
  );
  return (
    `${serviceName} declares it needs ${parts.join(" and ")}. ` +
    `It will still start, but may be throttled or OOM-killed — consider a larger sandbox size.`
  );
}
