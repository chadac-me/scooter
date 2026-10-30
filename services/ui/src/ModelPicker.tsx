/**
 * Per-conversation model picker. Fetches the agent-host's model catalog (GET /models)
 * per conversation and lets the user choose the model for the current conversation; the choice is
 * stored on the session (sessions.ts) and rides the next prompt via the X-Agent-Model
 * header (RuntimeProvider), so it works both at new-chat time and as a
 * mid-conversation switch. Hidden entirely when the server offers no models.
 */

import { useEffect, useRef, useState } from "react";

import { loadModels, type ModelCatalog } from "./client.js";
import { modelOptionLabel, modelOptionValue, defaultServingProvider, groupModelsByProvider } from "./modelGroups.js";
import { sessionStore, useSessions } from "./sessions.js";
import { useConversationInterrupts } from "./RuntimeProvider.js";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

export function ModelPicker() {
  const { sessions, currentId } = useSessions();
  const { isRunning } = useConversationInterrupts();
  const [catalog, setCatalog] = useState<ModelCatalog>({ default: null, available: [] });
  // "switching" is true from the user's pick until the next run finishes, since the
  // server rebuilds the agent with the new model on that run.
  const [switching, setSwitching] = useState(false);
  const wasRunning = useRef(false);

  useEffect(() => {
    let alive = true;
    // Refetched per conversation: BYOC status and ties shape the default.
    void loadModels({ baseUrl: BASE_URL }, currentId ?? undefined).then((c) => {
      if (alive) setCatalog(c);
    });
    return () => {
      alive = false;
    };
  }, [currentId]);

  // A run that began while switching has now finished -> the switch took effect.
  useEffect(() => {
    if (wasRunning.current && !isRunning) setSwitching(false);
    wasRunning.current = isRunning;
  }, [isRunning]);

  // Clear the pending switch when the conversation changes (it's per-conversation).
  useEffect(() => setSwitching(false), [currentId]);

  // Nothing (or only one option) to choose from -> don't show the picker.
  if (catalog.available.length <= 1) return null;

  // An unset conversation shows the host default so the select has a value, but is
  // marked inherited so it reads differently from an explicit pick.
  const explicitModel = sessions.find((s) => s.id === currentId)?.model;
  const current = explicitModel ?? catalog.default ?? "";
  /** The <select> value for a stored pick: provider-scoped when the catalog groups by
   *  provider, so a round-trip selects the option the user actually chose. */
  const selectValue = (() => {
    if (!current) return "";
    if (current.includes(":")) return current; // already provider-scoped
    const g = groupModelsByProvider(catalog.available, catalog.providers, catalog.default);
    if (!g) return current;
    // An inherited default sits under the provider that serves it.
    const serving = explicitModel === undefined ? defaultServingProvider(catalog) : undefined;
    const owner =
      g.find((x) => x.provider === serving && x.models.includes(current)) ?? g.find((x) => x.models.includes(current));
    return owner ? `${owner.provider}:${current}` : current;
  })();
  const inherited = explicitModel === undefined;

  return (
    // Lives inside the composer's action row, so it is a compact borderless inline pill.
    <div className="aui-model-picker flex items-center gap-1 text-xs text-muted-foreground">
      <label htmlFor="aui-model-select" className="sr-only">Model</label>
      <select
        id="aui-model-select"
        aria-label="Model"
        data-testid="model-picker"
        data-inherited={inherited || undefined}
        // Muted/italic while inheriting the default, so a never-switched conversation is
        // visually distinct.
        className={
          "rounded-md border-0 bg-transparent px-1.5 py-1 hover:bg-accent focus:bg-accent focus:outline-none cursor-pointer " +
          (inherited ? "italic text-muted-foreground" : "text-foreground")
        }
        title={inherited ? "Using the host default (not set for this conversation)" : "Model set for this conversation"}
        value={selectValue}
        onChange={(e) => {
          if (e.target.value !== selectValue) setSwitching(true);
          sessionStore.setModel(currentId, e.target.value);
        }}
      >
        {(() => {
          // The per-group default from defaultFor, so each group marks its own.
          const label = (m: string, provider?: string) =>
            modelOptionLabel(m, provider, {
              defaultFor: catalog.defaultFor,
              globalDefault: catalog.default,
              defaultProvider: defaultServingProvider(catalog),
            });
          // Two-level view when the catalog tags models with a provider, falling back to a flat list when none is tagged.
          const groups = groupModelsByProvider(catalog.available, catalog.providers, catalog.default);
          if (!groups) {
            return catalog.available.map((m) => (
              <option key={m} value={m}>{label(m)}</option>
            ));
          }
          return groups.map((g) => (
            <optgroup key={g.provider} label={g.label} data-testid={`model-group-${g.provider}`}>
              {g.models.map((m) => (
                // A provider-scoped value, so a model two providers offer yields distinguishable options.
                <option key={modelOptionValue(m, g.provider)} value={modelOptionValue(m, g.provider)}>{label(m, g.provider)}</option>
              ))}
            </optgroup>
          ));
        })()}
      </select>
      {inherited && !switching && (
        <span data-testid="model-inherited" className="text-[10px] uppercase tracking-wide opacity-60" title="Using the host default — not explicitly set for this conversation">
          inherited
        </span>
      )}
      {switching && (
        <span data-testid="model-switching" className="flex items-center gap-1" title="Applying the model change">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" aria-hidden />
          switching…
        </span>
      )}
    </div>
  );
}
