// The deployed catalog, through the same helpers the picker renders with.
//
// Refresh the fixture:
//   kubectl get deploy -n agent-sandbox agent-host -o json \
//     | jq -r '.spec.template.spec.containers[0].env[]
//              | select(.name=="AGENT_MODELS_JSON") | .value' \
//     | jq -S . > services/ui/src/__fixtures__/live-model-catalog.json
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  groupModelsByProvider,
  modelOptionLabel,
  modelOptionValue,
  defaultServingProvider,
} from "./modelGroups.js";

type LiveModel = { id: string; providers: string[]; defaultFor: string[]; default: boolean };

const LIVE: LiveModel[] = JSON.parse(
  readFileSync(new URL("./__fixtures__/live-model-catalog.json", import.meta.url), "utf8"),
);

const catalog = {
  available: LIVE.map((m) => m.id),
  default: LIVE.find((m) => m.default)?.id ?? null,
  providers: Object.fromEntries(LIVE.map((m) => [m.id, m.providers])),
  defaultFor: Object.fromEntries(LIVE.map((m) => [m.id, m.defaultFor])),
};

/** The options the picker would render, built from the same helpers it uses. */
function renderedOptions(): Array<{ value: string; text: string; provider: string }> {
  const groups = groupModelsByProvider(catalog.available, catalog.providers, catalog.default);
  if (!groups) {
    return catalog.available.map((m) => ({
      value: modelOptionValue(m, undefined),
      text: modelOptionLabel(m, undefined, {
        defaultFor: catalog.defaultFor,
        globalDefault: catalog.default,
      }),
      provider: "",
    }));
  }
  return groups.flatMap((g) =>
    g.models.map((m) => ({
      value: modelOptionValue(m, g.provider),
      text: modelOptionLabel(m, g.provider, {
        defaultFor: catalog.defaultFor,
        globalDefault: catalog.default,
        defaultProvider: defaultServingProvider(catalog),
      }),
      provider: g.provider,
    })),
  );
}

describe("the LIVE production model catalog", () => {
  it("GROUPS by provider — the branch where every picker bug has lived", () => {
    // A null here means the live catalog has gone untagged and the tests below prove nothing.
    const groups = groupModelsByProvider(catalog.available, catalog.providers, catalog.default);
    expect(groups, "the live catalog no longer groups — the tests below prove nothing").not.toBeNull();
    expect(groups!.map((g) => g.provider).sort()).toEqual(["byoc", "claude-code"]);
  });

  it("renders one option per (model, provider) pair", () => {
    const expected = LIVE.reduce((n, m) => n + m.providers.length, 0);
    expect(renderedOptions()).toHaveLength(expected);
  });

  it("every option value carries its provider, so a pick can route", () => {
    for (const o of renderedOptions()) {
      expect(o.value, `"${o.value}" has no provider prefix`).toMatch(/^[a-z-]+:.+/);
      expect(o.value).toBe(`${o.provider}:${o.value.slice(o.provider.length + 1)}`);
    }
  });

  it("REGRESSION: exactly ONE option is labelled (default)", () => {
    // The "(default)" label can only apply to one option.
    const defaulted = renderedOptions().filter((o) => o.text.includes("(default)"));
    expect(defaulted.map((o) => o.value)).toHaveLength(1);
    expect(defaulted[0].text).toContain(catalog.default!);
  });

  it("never marks a model (default) in a group that cannot run it", () => {
    for (const o of renderedOptions()) {
      if (!o.text.includes("(default)")) continue;
      const id = o.value.slice(o.provider.length + 1);
      const model = LIVE.find((m) => m.id === id);
      expect(model?.providers, `${id} marked default under ${o.provider}`).toContain(o.provider);
    }
  });

  it("exactly one model is provider-exclusive, so routing's reach is explicit", () => {
    // A group pick only binds for a model offered by one provider.
    expect(LIVE.filter((m) => m.providers.length === 1).map((m) => m.id)).toEqual([
      "claude-haiku-4-5",
    ]);
  });

  it("exactly one model is provider-exclusive, so routing's reach is explicit", () => {
    // A group pick only binds for a model offered by one provider.
    expect(LIVE.filter((m) => m.providers.length === 1).map((m) => m.id)).toEqual([
      "claude-haiku-4-5",
    ]);
  });

  it("exactly one model is provider-exclusive, so routing's reach is explicit", () => {
    // A group pick only binds for a model offered by one provider.
    expect(LIVE.filter((m) => m.providers.length === 1).map((m) => m.id)).toEqual([
      "claude-haiku-4-5",
    ]);
  });

  it("exactly one model is provider-exclusive, so routing's reach is explicit", () => {
    // A group pick only binds for a model offered by one provider.
    expect(LIVE.filter((m) => m.providers.length === 1).map((m) => m.id)).toEqual([
      "claude-haiku-4-5",
    ]);
  });

  it("GUARD: the live catalog can still tell per-provider labelling from global", () => {
    // Per-provider labelling must differ from global-default labelling on the live catalog, or the check above is vacuous.
    const perProvider = renderedOptions().map((o) => o.text);
    const globalOnly = (() => {
      const groups = groupModelsByProvider(catalog.available, catalog.providers, catalog.default)!;
      return groups.flatMap((g) =>
        g.models.map((m) => `${m}${m === catalog.default ? " (default)" : ""}`),
      );
    })();
    expect(
      perProvider,
      "live catalog cannot distinguish per-provider labels from the global default: " +
        "no model has defaultFor as a strict subset of its providers, so this suite " +
        "would pass with the pre-#739 bug reintroduced. Fix the DEPLOYED catalog " +
        "(see the regression test above) or add a synthetic case.",
    ).not.toEqual(globalOnly);
  });
});
