/**
 * The default the model picker shows for an unset conversation is the model its run will
 * use: the BYOC default while the owner's container is connected, else the floor's (#1019).
 */

import { describe, it, expect, vi } from "vitest";

import { catalogFromEnv } from "../../src/agent/models.js";
import { resolveUnsetDefault } from "../../src/index.js";

const cat = catalogFromEnv({
  AGENT_MODELS_JSON: JSON.stringify([
    { id: "claude-opus-5-5", providers: ["byoc"], defaultFor: ["byoc"], priorities: { byoc: 10 } },
    { id: "us.xai.grok-4.7", providers: ["goose"], defaultFor: ["goose"], default: true },
  ]),
} as NodeJS.ProcessEnv);
const cfg = { model: cat.defaultId, availableModels: cat.models.map((m) => m.id), modelCatalog: cat };

describe("resolveUnsetDefault", () => {
  it("a connected BYOC owner gets the byoc default", async () => {
    const connected = vi.fn(async () => true);
    expect(await resolveUnsetDefault(cfg, connected, "alice", "c1")).toEqual({
      model: "claude-opus-5-5",
      provider: "byoc",
    });
    expect(connected).toHaveBeenCalledWith("alice");
  });

  it("a disconnected owner gets the floor default", async () => {
    expect(await resolveUnsetDefault(cfg, async () => false, "alice", "c1")).toEqual({
      model: "us.xai.grok-4.7",
      provider: "goose",
    });
  });

  it("an anonymous caller never asks about BYOC", async () => {
    const connected = vi.fn(async () => true);
    expect((await resolveUnsetDefault(cfg, connected, undefined, "c1")).provider).toBe("goose");
    expect(connected).not.toHaveBeenCalled();
  });

  it("a catalog without byoc models stays on the floor", async () => {
    const floorOnly = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([{ id: "us.xai.grok-4.7", providers: ["goose"], defaultFor: ["goose"] }]),
    } as NodeJS.ProcessEnv);
    const c = { model: floorOnly.defaultId, availableModels: ["us.xai.grok-4.7"], modelCatalog: floorOnly };
    expect(await resolveUnsetDefault(c, async () => true, "alice", "c1")).toEqual({
      model: "us.xai.grok-4.7",
      provider: "goose",
    });
  });
});

describe("resolveUnsetDefault on an untagged floor", () => {
  it("names no provider, so the UI does not hide every (default) label", async () => {
    const byocOnly = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([{ id: "claude-opus-5-5", providers: ["byoc"], defaultFor: ["byoc"] }]),
    } as NodeJS.ProcessEnv);
    const c = { model: "claude-opus-5-5", availableModels: ["claude-opus-5-5"], modelCatalog: byocOnly };
    expect(await resolveUnsetDefault(c, async () => false, "alice", "c1")).toEqual({
      model: "claude-opus-5-5",
      provider: undefined,
    });
  });
});
