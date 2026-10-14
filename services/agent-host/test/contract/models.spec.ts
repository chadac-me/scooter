/**
 * The model catalog: AGENT_MODELS_JSON parses with hints, defaults and providers, the
 * legacy GOOSE_MODEL + AGENT_AVAILABLE_MODELS form still yields a catalog, exactly one
 * default is derived, and resolveModel guards against unoffered models.
 */

import { describe, it, expect } from "vitest";

import {
  catalogFromEnv,
  resolveModel,
  isOffered,
  availableIds,
} from "../../src/agent/models.js";

describe("model catalog", () => {
  it("parses AGENT_MODELS_JSON with hints + a default flag", () => {
    const cat = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([
        { id: "sonnet", hint: "fast/cheap", default: true },
        { id: "opus", hint: "slow/powerful" },
      ]),
    } as NodeJS.ProcessEnv);
    expect(availableIds(cat)).toEqual(["sonnet", "opus"]);
    expect(cat.defaultId).toBe("sonnet");
    expect(cat.models.find((m) => m.id === "opus")!.hint).toBe("slow/powerful");
    expect(cat.models.find((m) => m.id === "opus")!.default).toBe(false);
  });

  it("derives a default when none is flagged (first model)", () => {
    const cat = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([{ id: "a" }, { id: "b" }]),
    } as NodeJS.ProcessEnv);
    expect(cat.defaultId).toBe("a");
    expect(cat.models[0].default).toBe(true);
    expect(cat.models[1].default).toBe(false);
  });

  it("normalizes to exactly one default even if two are flagged", () => {
    const cat = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([
        { id: "a", default: true },
        { id: "b", default: true },
      ]),
    } as NodeJS.ProcessEnv);
    expect(cat.models.filter((m) => m.default)).toHaveLength(1);
    expect(cat.defaultId).toBe("a");
  });

  it("falls back to the legacy GOOSE_MODEL + AGENT_AVAILABLE_MODELS (no hints)", () => {
    const cat = catalogFromEnv({
      GOOSE_MODEL: "opus",
      AGENT_AVAILABLE_MODELS: "opus, sonnet",
    } as NodeJS.ProcessEnv);
    expect(availableIds(cat)).toEqual(["opus", "sonnet"]);
    expect(cat.defaultId).toBe("opus");
    expect(cat.models.every((m) => m.hint === "")).toBe(true);
  });

  it("legacy: the default is included even if not in AGENT_AVAILABLE_MODELS", () => {
    const cat = catalogFromEnv({
      GOOSE_MODEL: "opus",
      AGENT_AVAILABLE_MODELS: "sonnet",
    } as NodeJS.ProcessEnv);
    expect(availableIds(cat)).toContain("opus");
    expect(cat.defaultId).toBe("opus");
  });

  it("empty env -> empty catalog, resolveModel undefined", () => {
    const cat = catalogFromEnv({} as NodeJS.ProcessEnv);
    expect(cat.models).toEqual([]);
    expect(resolveModel("anything", cat)).toBeUndefined();
  });

  it("malformed AGENT_MODELS_JSON falls back to legacy (never throws)", () => {
    const cat = catalogFromEnv({
      AGENT_MODELS_JSON: "not json",
      GOOSE_MODEL: "opus",
    } as NodeJS.ProcessEnv);
    expect(cat.defaultId).toBe("opus");
  });

  it("resolveModel returns the requested model only if offered, else the default", () => {
    const cat = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([{ id: "sonnet", default: true }, { id: "opus" }]),
    } as NodeJS.ProcessEnv);
    expect(resolveModel("opus", cat)).toBe("opus");
    expect(resolveModel("gpt-4", cat)).toBe("sonnet");
    expect(resolveModel(undefined, cat)).toBe("sonnet");
    expect(isOffered(cat, "opus")).toBe(true);
    expect(isOffered(cat, "gpt-4")).toBe(false);
  });
});

// --- the provider dimension ------------------------------------------------------------------
//
// Model ids are provider-specific namespaces, so each model may declare which providers offer it, with empty meaning all.

import { modelAllowedFor, defaultFor } from "../../src/agent/models.js";

describe("model catalog: provider dimension", () => {
  const catalog = catalogFromEnv({
    AGENT_MODELS_JSON: JSON.stringify([
      { id: "us.anthropic.claude-sonnet-4-6", default: true, providers: ["goose", "claude-code"] },
      { id: "us.anthropic.claude-opus-4-8", providers: ["goose"] },
      { id: "claude-sonnet-4-5", providers: ["byoc"] },
      { id: "everywhere-model" },
    ]),
  } as never);

  it("parses providers from AGENT_MODELS_JSON (absent = [])", () => {
    expect(catalog.models.find((m) => m.id === "claude-sonnet-4-5")?.providers).toEqual(["byoc"]);
    expect(catalog.models.find((m) => m.id === "everywhere-model")?.providers).toEqual([]);
  });

  it("modelAllowedFor: tagged models bind to their providers; untagged allow all", () => {
    expect(modelAllowedFor(catalog, "us.anthropic.claude-opus-4-8", "goose")).toBe(true);
    expect(modelAllowedFor(catalog, "us.anthropic.claude-opus-4-8", "byoc")).toBe(false);
    expect(modelAllowedFor(catalog, "everywhere-model", "byoc")).toBe(true);
    expect(modelAllowedFor(catalog, "not-in-catalog", "byoc")).toBe(false);
  });

  it("a run with NO provider tag (legacy provider) allows any catalog model", () => {
    expect(modelAllowedFor(catalog, "claude-sonnet-4-5", undefined)).toBe(true);
  });

  it("defaultFor: the global default when the provider offers it, else the provider's first", () => {
    expect(defaultFor(catalog, "goose")).toBe("us.anthropic.claude-sonnet-4-6");
    // byoc does not offer the global default, so it gets its first offered model.
    expect(defaultFor(catalog, "byoc")).toBe("claude-sonnet-4-5");
    expect(defaultFor(catalog, undefined)).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("defaultFor: a provider GROUP's own flagged default wins over the global default", () => {
    // Each provider group marks its own default in the kubenix surface.
    const c = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([
        { id: "us.anthropic.claude-sonnet-4-6", default: true, providers: ["goose"], defaultFor: ["goose"] },
        { id: "claude-sonnet-4-5", providers: ["byoc"] },
        { id: "claude-opus-4-8", providers: ["byoc"], defaultFor: ["byoc"] },
      ]),
    } as never);
    expect(defaultFor(c, "byoc")).toBe("claude-opus-4-8");
  });

  it("defaultFor: a provider with nothing tagged still gets the untagged models", () => {
    const c = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([{ id: "m1", default: true }]),
    } as never);
    expect(defaultFor(c, "byoc")).toBe("m1");
  });
});
