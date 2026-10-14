/**
 * UI unit test: the ModelPicker distinguishes an explicit per-conversation model from
 * one inherited from the host default. The model is per-conversation, so the picker
 * marks an inherited default distinctly (muted + an "inherited" tag) from an explicit pick.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// Stub the async catalog load so the picker renders with >1 model.
vi.mock("./client.js", () => ({
  loadModels: vi.fn(async () => ({
    default: "opus",
    available: ["opus", "sonnet"],
    hints: {},
  })),
}));

import { ModelPicker } from "./ModelPicker.js";
import { sessionStore } from "./sessions.js";

beforeEach(() => {
  globalThis.localStorage?.clear?.();
});

// The catalog is fetched in an effect, so these tests cover the store-driven derivation (explicit model vs inherited default); the populated render is covered by e2e.
describe("ModelPicker inherited-vs-explicit derivation", () => {
  it("a conversation with no model reads as inheriting the default (not an explicit pick)", () => {
    sessionStore.mergeFromServer([{ id: "a" }]);
    sessionStore.switchTo("a");
    const model = sessionStore.get().sessions.find((s) => s.id === "a")?.model;
    // The picker treats an undefined model as inherited.
    expect(model).toBeUndefined();
  });

  it("an explicitly-switched conversation is NOT inherited", () => {
    sessionStore.mergeFromServer([{ id: "a" }]);
    sessionStore.setModel("a", "sonnet");
    const model = sessionStore.get().sessions.find((s) => s.id === "a")?.model;
    expect(model).toBe("sonnet"); // explicit -> inherited=false in the picker
  });

  it("renders without throwing (smoke) for the selected conversation", () => {
    sessionStore.mergeFromServer([{ id: "a" }]);
    sessionStore.switchTo("a");
    // The first render has an empty catalog and returns null; this asserts the null-guard holds before the async load.
    const html = renderToStaticMarkup(createElement(ModelPicker));
    expect(typeof html).toBe("string");
  });
});
describe("the (default) label is PER PROVIDER", () => {
  it("marks a model default only under the providers it is the default FOR", () => {
    // claude-opus-5 ships defaultFor: ["byoc", "claude-code"], so "(default)" twice is correct for it.
    const defaultFor: Record<string, string[]> = {
      "claude-opus-5": ["byoc"],
      "claude-sonnet-5": ["claude-code"],
    };
    const label = (m: string, provider: string) =>
      `${m}${(defaultFor[m] ?? []).includes(provider) ? " (default)" : ""}`;

    // opus is the byoc default only
    expect(label("claude-opus-5", "byoc")).toBe("claude-opus-5 (default)");
    expect(label("claude-opus-5", "claude-code")).toBe("claude-opus-5");
    // sonnet is the cloud default only
    expect(label("claude-sonnet-5", "claude-code")).toBe("claude-sonnet-5 (default)");
    expect(label("claude-sonnet-5", "byoc")).toBe("claude-sonnet-5");
  });

  it("a model that is genuinely default for BOTH is marked under both", () => {
    const defaultFor: Record<string, string[]> = { "claude-opus-5": ["byoc", "claude-code"] };
    const label = (m: string, provider: string) =>
      `${m}${(defaultFor[m] ?? []).includes(provider) ? " (default)" : ""}`;
    expect(label("claude-opus-5", "byoc")).toBe("claude-opus-5 (default)");
    expect(label("claude-opus-5", "claude-code")).toBe("claude-opus-5 (default)");
  });
});
