// The deployed catalog as a fixture, refreshed per ui/src/__fixtures__.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogFromEnv, modelAllowedFor, defaultFor } from "../../src/agent/models.js";

const RAW = readFileSync(
  join(__dirname, "../../../../ui/src/__fixtures__/live-model-catalog.json"),
  "utf8",
);

describe("the LIVE model catalog", () => {
  // Through the same entry point production uses, with the same env vars.
  const catalog = catalogFromEnv({
    AGENT_MODELS_JSON: RAW,
    GOOSE_MODEL: "claude-opus-5",
  } as NodeJS.ProcessEnv);

  it("parses every model, keeping providers AND defaultFor", () => {
    expect(catalog.models.length).toBeGreaterThanOrEqual(5);
    // The rich JSON path yields a catalog whose models carry provider tags and per-provider defaults.
    expect(catalog.models.some((m) => m.providers.length > 0)).toBe(true);
    expect(catalog.models.some((m) => m.defaultFor.length > 0)).toBe(true);
  });

  it("DOCUMENTS the production shape that makes two groups both say (default)", () => {
    // claude-opus-5 is the default for both providers, so a per-group label marks it under each.
    const both = catalog.models.filter(
      (m) => m.defaultFor.includes("byoc") && m.defaultFor.includes("claude-code"),
    );
    expect(
      both.map((m) => m.id),
      "a model that is defaultFor BOTH providers renders (default) under both groups",
    ).toEqual(["claude-opus-5"]);
  });

  it("every defaultFor provider is one the model actually offers", () => {
    // A model must not be marked default for a provider it is not offered by.
    for (const m of catalog.models) {
      for (const p of m.defaultFor) {
        expect(m.providers, `${m.id} is defaultFor ${p} but not offered by it`).toContain(p);
      }
    }
  });

  it("names exactly one provider-exclusive model, so the gate is honest about its reach", () => {
    // Routing only binds for a model exclusive to one provider.
    const exclusive = catalog.models.filter((m) => m.providers.length === 1);
    expect(exclusive.map((m) => m.id)).toEqual(["claude-haiku-4-5"]);
  });
});
