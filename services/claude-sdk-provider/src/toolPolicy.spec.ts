/** The policy that keeps an unwired tool from hanging the turn on a headless permission prompt. */
import { describe, it, expect } from "vitest";

import { decideTool, TOOL_REDIRECTS } from "./toolPolicy.js";

const ALIASES = ["mcp__sandbox__bash", "mcp__sandbox__glob"];

describe("decideTool", () => {
  it("DENIES an unknown tool rather than letting it prompt", () => {
    // A built-in shipped by a newer CLI lands here and must be denied rather than prompt.
    const d = decideTool("SomeToolFromANewerCLI", ALIASES);
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toMatch(/not available/i);
    expect(d.allow === false && d.reason).toMatch(/do not retry/i);
  });

  it("redirects each unsupported built-in to its scooter-env equivalent", () => {
    for (const [tool, expected] of Object.entries(TOOL_REDIRECTS)) {
      const d = decideTool(tool, ALIASES);
      expect(d.allow, `${tool} must be denied`).toBe(false);
      expect(d.allow === false && d.reason).toBe(expected);
    }
  });

  it("names the replacement, so the model can self-correct", () => {
    expect(decideTool("WebSearch", ALIASES)).toMatchObject({ reason: /web_search/ });
    expect(decideTool("WebFetch", ALIASES)).toMatchObject({ reason: /web_fetch/ });
    expect(decideTool("Task", ALIASES)).toMatchObject({ reason: /spawn_subagent/ });
  });

  it("tells AskUserQuestion to state the question and proceed, not block @proves", () => {
    const d = decideTool("AskUserQuestion", ALIASES);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/state the question/i);
    expect(d.reason).toMatch(/continue|proceeding/i);
  });

  it("allows ToolSearch — the scooter-env tools are deferred and need discovery @proves", () => {
    // Denying it leaves the model unable to enumerate the deferred toolset.
    expect(decideTool("ToolSearch", ALIASES).allow).toBe(true);
  });

  it("allows TodoWrite (pure in-process state)", () => {
    expect(decideTool("TodoWrite", ALIASES).allow).toBe(true);
  });

  it("allows every mcp__ tool — sandbox, scooter-env, and BYOC-tunnelled servers", () => {
    expect(decideTool("mcp__sandbox__bash", []).allow).toBe(true);
    expect(decideTool("mcp__scooter-env__list_models", []).allow).toBe(true);
    expect(decideTool("mcp__some-byoc-server__thing", []).allow).toBe(true);
  });

  it("allows the aliased tool names themselves", () => {
    expect(decideTool("mcp__sandbox__glob", ALIASES).allow).toBe(true);
  });

  it("tells a LOCAL built-in to use its sandbox alias", () => {
    // If a disallowed built-in reaches the hook, the reason names the sandbox alias rather than the generic refusal.
    const d = decideTool("Bash", ALIASES);
    expect(d.allow).toBe(false);
    expect(d.allow === false && d.reason).toMatch(/sandbox/i);
  });

  it("denies NotebookEdit without inventing a replacement", () => {
    const d = decideTool("NotebookEdit", ALIASES);
    expect(d.allow).toBe(false);
    // marimo notebooks are .py, which the sandbox edit tool covers.
    expect(d.allow === false && d.reason).toMatch(/edit/i);
  });
});
it("THE BUG: Skill is allowed — deny-by-default made every skill unreachable", () => {
  // A discovered skill is unreachable unless the Skill tool itself is allowed.
  expect(decideTool("Skill").allow).toBe(true);
});

it("an unknown built-in is still denied (deny-by-default intact)", () => {
  expect(decideTool("NotARealTool").allow).toBe(false);
});

