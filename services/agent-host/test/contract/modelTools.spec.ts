/**
 * The list_models and switch_model MCP tool handlers: the agent lists offered models
 * with hints and current/default tags and switches its own model, with validation here
 * (an unoffered model is refused with the valid list) and the mechanism in the manager.
 */

import { describe, it, expect, vi } from "vitest";

import { handleListModels, handleSwitchModel, type ModelToolsWiring } from "../../src/agent/modelTools.js";
import { catalogFromEnv } from "../../src/agent/models.js";

const CATALOG = catalogFromEnv({
  AGENT_MODELS_JSON: JSON.stringify([
    { id: "sonnet", hint: "fast/cheap — simple edits", default: true },
    { id: "opus", hint: "slow/powerful — architecture" },
  ]),
} as NodeJS.ProcessEnv);

function wiring(over: Partial<ModelToolsWiring> = {}): { deps: ModelToolsWiring; switched: Array<[string, string]> } {
  const switched: Array<[string, string]> = [];
  const deps: ModelToolsWiring = {
    catalog: CATALOG,
    currentModel: () => "sonnet",
    switchModel: vi.fn(async (id: string, model: string) => {
      switched.push([id, model]);
      return model !== "sonnet";
    }),
    ...over,
  };
  return { deps, switched };
}

describe("list_models", () => {
  it("lists every offered model with its hint + current/default tags", () => {
    const { deps } = wiring();
    const text = handleListModels(deps, "c1").content[0].text;
    expect(text).toContain("sonnet");
    expect(text).toContain("fast/cheap — simple edits");
    expect(text).toContain("opus");
    expect(text).toContain("slow/powerful — architecture");
    // sonnet is both current and default.
    expect(text).toMatch(/sonnet.*current/);
    expect(text).toMatch(/sonnet.*default/);
  });

  it("marks the CURRENT model even when it differs from the default", () => {
    const { deps } = wiring({ currentModel: () => "opus" });
    const text = handleListModels(deps, "c1").content[0].text;
    expect(text).toMatch(/opus.*current/);
    expect(text).not.toMatch(/sonnet.*current/);
  });

  it("tells the agent to KEEP a model the user picked", () => {
    const { deps } = wiring({ currentModel: () => "opus", modelSetBy: () => "user" });
    const text = handleListModels(deps, "c1").content[0].text;
    expect(text).toMatch(/opus.*current, picked by the user/);
    expect(text).toContain("keep it unless they ask you to switch");
  });

  it("marks a model the agent chose, without the keep instruction", () => {
    const { deps } = wiring({ currentModel: () => "opus", modelSetBy: () => "agent" });
    const text = handleListModels(deps, "c1").content[0].text;
    expect(text).toMatch(/opus.*current, chosen by you/);
    expect(text).not.toContain("picked by the user");
  });

  it("leaves an inherited default unmarked", () => {
    const text = handleListModels(wiring().deps, "c1").content[0].text;
    expect(text).not.toMatch(/picked by the user|chosen by you/);
  });

  it("says so when no models are configured", () => {
    const empty = catalogFromEnv({} as NodeJS.ProcessEnv);
    const text = handleListModels(wiring({ catalog: empty }).deps, "c1").content[0].text;
    expect(text.toLowerCase()).toContain("no models");
  });
});

describe("switch_model", () => {
  it("switches to a valid model and reports the continue", async () => {
    const { deps, switched } = wiring();
    const res = await handleSwitchModel(deps, "c1", { model: "opus" });
    expect(res.isError).toBeFalsy();
    expect(switched).toEqual([["c1", "opus"]]);
    expect(res.content[0].text).toContain("opus");
  });

  it("REFUSES an unoffered model and returns the valid list (never switches blind)", async () => {
    const { deps, switched } = wiring();
    const res = await handleSwitchModel(deps, "c1", { model: "gpt-4" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("sonnet");
    expect(res.content[0].text).toContain("opus");
    expect(switched).toEqual([]);
  });

  it("errors on an empty model with the available list", async () => {
    const { deps, switched } = wiring();
    const res = await handleSwitchModel(deps, "c1", { model: "  " });
    expect(res.isError).toBe(true);
    expect(switched).toEqual([]);
  });

  it("reports 'already on it' when the switch was a no-op", async () => {
    const { deps } = wiring();
    const res = await handleSwitchModel(deps, "c1", { model: "sonnet" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.toLowerCase()).toContain("already");
  });
});
