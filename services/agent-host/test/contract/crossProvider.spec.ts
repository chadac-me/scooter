/**
 * Cross-provider consistency driven by recorded transcripts: every scenario recorded
 * for both claude and goose must yield consistent provider-normalized SessionUpdates,
 * and adding a fixture pair extends coverage with no test edit. Updates are re-derived
 * from the recorded input through the live adapter, so the tests reflect current code.
 */

import { describe, it, expect } from "vitest";

import { scenariosForAllProviders, providersWith, derivedUpdateTypes, assistantText } from "../support/transcript.js";

const scenarios = scenariosForAllProviders();

// Scenarios whose prompt forces a tool call; open-ended scenarios let the model decide, so tool consistency is only asserted here.
const TOOL_MANDATORY = new Set(["shell-tool-and-result", "subagent-poll-loop"]);

describe("cross-provider transcript consistency", () => {
  it("has at least one scenario recorded on both providers", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  describe.each(scenarios)("scenario: %s", (scenario) => {
    const providers = providersWith(scenario);

    it("is recorded for both claude and goose", () => {
      expect(providers.sort()).toEqual(["claude", "goose"]);
    });

    (TOOL_MANDATORY.has(scenario) ? it : it.skip)("every provider calls a tool (tool-mandatory scenario)", async () => {
      for (const p of providers) {
        expect(await derivedUpdateTypes(p, scenario), `${p} did not call a tool`).toContain("tool_call");
      }
    });

    it("surfaces the tool RESULT wherever a tool was called (consistent)", async () => {
      const perProvider = await Promise.all(providers.map((p) => derivedUpdateTypes(p, scenario)));
      for (let i = 0; i < providers.length; i++) {
        if (perProvider[i].includes("tool_call")) {
          expect(perProvider[i], `${providers[i]} called a tool but dropped its result`).toContain("tool_call_update");
        }
      }
    });

    it("produces assistant text on every provider (a run always says something)", async () => {
      for (const p of providers) {
        expect(await derivedUpdateTypes(p, scenario), `${p} produced no assistant text`).toContain("agent_message_chunk");
      }
    });
  });

  // The multi-turn fixture tells the agent a secret in turn 1 and asks for it in turn 2, so lost cross-turn context fails the recall.
  const multiTurn = "multi-turn";
  (providersWith(multiTurn).length === 2 ? describe : describe.skip)("scenario: multi-turn (session continuity)", () => {
    it.each(providersWith(multiTurn))("%s recalls the turn-1 secret in its turn-2 reply", (provider) => {
      expect(assistantText(provider, multiTurn).toUpperCase(), `${provider} lost cross-turn context`).toContain("ZEBRA");
    });
  });
});
