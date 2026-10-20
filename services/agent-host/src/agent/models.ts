/**
 * Model catalog: the set of models a conversation may run on, each with an optional
 * deployment hint guiding when to use it, which the agent picks between via the
 * list_models / switch_model MCP tools. The source of truth is the AGENT_MODELS_JSON
 * env var rendered by modules/platform.nix; a comma-separated AGENT_AVAILABLE_MODELS
 * plus GOOSE_MODEL also yields a catalog without hints.
 */

/** One offered model. */
export interface ModelInfo {
  id: string;
  /** Deployment guidance shown to the agent by list_models; "" means none. */
  hint: string;
  /** The one default model, used when a conversation has not picked one. */
  default: boolean;
  /** Which providers ("goose", "claude-code", "byoc") offer this model, since ids are provider-specific namespaces; empty means every provider. */
  providers: string[];
  /** The providers this model is the default for. */
  defaultFor: string[];
  /** The deployer-declared context window in tokens, overriding goose's own model table. */
  contextLimit?: number;
}

export interface ModelCatalog {
  models: ModelInfo[];
  /** The default model id, or undefined if none. */
  defaultId?: string;
}

/** Build the catalog from the environment, preferring AGENT_MODELS_JSON over GOOSE_MODEL + AGENT_AVAILABLE_MODELS. */
export function catalogFromEnv(env: NodeJS.ProcessEnv = process.env): ModelCatalog {
  const json = env.AGENT_MODELS_JSON;
  if (json && json.trim()) {
    try {
      const parsed = JSON.parse(json) as Array<{
        id?: unknown; hint?: unknown; default?: unknown; providers?: unknown; defaultFor?: unknown;
        contextLimit?: unknown;
      }>;
      const models: ModelInfo[] = [];
      for (const m of Array.isArray(parsed) ? parsed : []) {
        if (typeof m?.id !== "string" || !m.id) continue;
        models.push({
          id: m.id,
          hint: typeof m.hint === "string" ? m.hint : "",
          default: m.default === true,
          providers: Array.isArray(m.providers) ? m.providers.filter((x): x is string => typeof x === "string") : [],
          defaultFor: Array.isArray(m.defaultFor) ? m.defaultFor.filter((x): x is string => typeof x === "string") : [],
          ...(isPositiveInt(m.contextLimit) ? { contextLimit: m.contextLimit } : {}),
        });
      }
      return withDefault(models);
    } catch {
      // Fall through to the env-list form.
    }
  }
  // GOOSE_MODEL is the default and AGENT_AVAILABLE_MODELS the hint-less list.
  const legacyDefault = env.GOOSE_MODEL?.trim() || undefined;
  const ids = (env.AGENT_AVAILABLE_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (legacyDefault && !ids.includes(legacyDefault)) ids.unshift(legacyDefault);
  const models: ModelInfo[] = ids.map((id) => ({ id, hint: "", default: id === legacyDefault, providers: [], defaultFor: [] }));
  return withDefault(models, legacyDefault);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** The declared context window of model `id`, or undefined when it declares none or is not offered. */
export function contextLimitOf(cat: ModelCatalog, id: string | undefined): number | undefined {
  return id === undefined ? undefined : cat.models.find((m) => m.id === id)?.contextLimit;
}

/** Ensure exactly one default is marked: an explicit default:true, else `fallback`, else the first model. */
function withDefault(models: ModelInfo[], fallback?: string): ModelCatalog {
  if (models.length === 0) return { models: [], defaultId: fallback };
  let def = models.find((m) => m.default);
  if (!def && fallback) def = models.find((m) => m.id === fallback);
  if (!def) def = models[0];
  // Normalize the flags so exactly `def` is the default.
  for (const m of models) m.default = m.id === def.id;
  return { models, defaultId: def.id };
}

/** The offered model ids. */
export function availableIds(cat: ModelCatalog): string[] {
  return cat.models.map((m) => m.id);
}

/** The requested model if it is offered, otherwise the default (undefined only when the catalog is empty). */
export function resolveModel(requested: string | undefined, cat: ModelCatalog): string | undefined {
  if (requested && cat.models.some((m) => m.id === requested)) return requested;
  return cat.defaultId;
}

/** Whether `id` is an offered model. */
export function isOffered(cat: ModelCatalog, id: string): boolean {
  return cat.models.some((m) => m.id === id);
}

/** Whether a run on the provider tagged `tag` may use model `id`; untagged models and untagged runs accept anything in the catalog. */
export function modelAllowedFor(catalog: ModelCatalog, id: string, tag: string | undefined): boolean {
  const m = catalog.models.find((x) => x.id === id);
  if (!m) return false;
  if (!tag || m.providers.length === 0) return true;
  return m.providers.includes(tag);
}

/** The model a run on provider `tag` should use absent a valid choice: the provider's own default, else the global default if offered, else the first model the provider offers. */
export function defaultFor(catalog: ModelCatalog, tag: string | undefined): string | undefined {
  if (tag) {
    const flagged = catalog.models.find((m) => m.defaultFor.includes(tag));
    if (flagged) return flagged.id;
  }
  if (catalog.defaultId && modelAllowedFor(catalog, catalog.defaultId, tag)) return catalog.defaultId;
  return catalog.models.find((m) => modelAllowedFor(catalog, m.id, tag))?.id;
}
