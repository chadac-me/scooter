/**
 * goose approve-mode back-pressure: a tool-gate permission request is auto-answered
 * without a UI prompt, allowed normally and rejected when a priority item is waiting.
 */

import { describe, it, expect } from "vitest";

import { answerToolGate, autoAnswerPermission, isToolGate } from "../../src/acp/client.js";

// A goose approve-mode tool gate: allow and reject options for running a tool.
const OPTS = [
  { optionId: "allow", kind: "allow_once" },
  { optionId: "allow-always", kind: "allow_always" },
  { optionId: "reject", kind: "reject_once" },
];

// An agent-presented choice the user must answer: distinct options with no reject kind.
const USER_CHOICE = [
  { optionId: "red", kind: "allow_once" },
  { optionId: "green", kind: "allow_once" },
  { optionId: "blue", kind: "allow_once" },
];

describe("isToolGate", () => {
  it("is TRUE only when both an allow-kind AND a reject-kind option are present", () => {
    expect(isToolGate(OPTS)).toBe(true);
    expect(isToolGate(USER_CHOICE)).toBe(false);
    expect(isToolGate([{ kind: "reject_once" }])).toBe(false);
    expect(isToolGate([])).toBe(false);
  });
});

describe("autoAnswerPermission (goose approve-mode)", () => {
  it("ALLOWS (picks an allow option) when NOT yielding — preserves auto-run", () => {
    const res = autoAnswerPermission(OPTS, false);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("REJECTS (picks a reject option) when yielding — goose ends the turn", () => {
    const res = autoAnswerPermission(OPTS, true);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("does NOT auto-answer an agent-presented CHOICE — returns undefined so it reaches the UI", () => {
    expect(autoAnswerPermission(USER_CHOICE, false)).toBeUndefined();
    expect(autoAnswerPermission(USER_CHOICE, true)).toBeUndefined();
  });

  it("returns undefined when there are no options (caller falls through)", () => {
    expect(autoAnswerPermission([], false)).toBeUndefined();
  });
});

describe("answerToolGate (PreToolUse hooks at goose's approve-mode gate)", () => {
  const call = { toolCallId: "c1", title: "Shell", rawInput: { command: "git push -f" } };

  it("REJECTS when a hook refuses, and passes the hook the tool's title and input", async () => {
    const seen: unknown[] = [];
    const res = await answerToolGate(
      { options: OPTS, toolCall: call },
      { gateTool: async (c) => (seen.push(c), "no force-push") },
    );
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(seen).toEqual([call]);
  });

  it("ALLOWS when hooks pass and nothing is waiting, and still yields to a priority item", async () => {
    const pass = async () => undefined;
    expect(await answerToolGate({ options: OPTS, toolCall: call }, { gateTool: pass })).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(await answerToolGate({ options: OPTS, toolCall: call }, { gateTool: pass, shouldYield: () => true })).toEqual({
      outcome: { outcome: "selected", optionId: "reject" },
    });
  });

  it("ALLOWS when a hook throws, since a broken hook must not wedge goose", async () => {
    const res = await answerToolGate({ options: OPTS, toolCall: call }, { gateTool: async () => { throw new Error("x"); } });
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("leaves an agent-presented choice to the UI and answers nothing without hooks or back-pressure", async () => {
    expect(await answerToolGate({ options: USER_CHOICE, toolCall: call }, { gateTool: async () => "no" })).toBeUndefined();
    expect(await answerToolGate({ options: OPTS, toolCall: call }, {})).toBeUndefined();
  });
});
