/** Conversation tool hooks inside the SDK's own PreToolUse/PostToolUse. */

import { describe, it, expect } from "vitest";

import { createSdkAcpClient } from "./sdkClient.js";
import type { ExecBackend, ToolHooks } from "./types.js";

const fakeExec = {} as unknown as ExecBackend;

type Hook = (input: unknown, toolUseId?: string) => Promise<Record<string, any>>;

/** The SDK hook callbacks one fake turn was given. */
async function hooksFor(toolHooks?: ToolHooks) {
  let options: Record<string, any> = {};
  const queryImpl = ({ options: o }: { options: Record<string, any> }) => {
    options = o;
    return (async function* () {
      yield { type: "result", subtype: "success", session_id: "s" };
    })();
  };
  const client = await createSdkAcpClient({
    oauthToken: "t",
    model: "claude-x",
    exec: fakeExec,
    systemPrompt: "hi",
    queryImpl: queryImpl as never,
    toolHooks,
  });
  await client.newSession({ threadId: "c1" } as never);
  await client.prompt({ prompt: [{ type: "text", text: "go" }] } as never);
  const pre = options.hooks.PreToolUse[0].hooks[0] as Hook;
  const post = options.hooks.PostToolUse?.[0].hooks[0] as Hook | undefined;
  return { pre, post };
}

describe("SDK tool hooks", () => {
  it("adds no PostToolUse and changes nothing without hooks", async () => {
    const { pre, post } = await hooksFor();
    expect(post).toBeUndefined();
    expect(await pre({ tool_name: "mcp__sandbox__bash", tool_input: { command: "ls" } })).toEqual({ continue: true });
  });

  it("passes sandbox tools to hooks by their built-in name and honours a deny", async () => {
    const seen: string[] = [];
    const { pre } = await hooksFor({
      pre: async (name) => {
        seen.push(name);
        return name === "Bash" ? { deny: "no force-push" } : {};
      },
      post: async () => ({}),
    });
    const out = await pre({ tool_name: "mcp__sandbox__bash", tool_input: { command: "git push -f" } }, "tu1");
    expect(seen).toEqual(["Bash"]);
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no force-push" });
  });

  it("rewrites the input and adds context when a hook asks", async () => {
    const { pre } = await hooksFor({
      pre: async () => ({ updatedInput: { command: "ls -la" }, context: "listing is cheap" }),
      post: async () => ({}),
    });
    const out = await pre({ tool_name: "mcp__sandbox__bash", tool_input: { command: "ls" } });
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: "ls -la" },
      additionalContext: "listing is cheap",
    });
  });

  it("never consults hooks for a call the platform policy already refuses", async () => {
    let called = false;
    const { pre } = await hooksFor({
      pre: async () => {
        called = true;
        return {};
      },
      post: async () => ({}),
    });
    const out = await pre({ tool_name: "Task" });
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(called).toBe(false);
  });

  it("returns PostToolUse feedback as a block reason and context", async () => {
    const { post } = await hooksFor({
      pre: async () => ({}),
      post: async (name, _input, response) => (name === "Edit" && response === "ok" ? { block: "lint failed", context: "2 errors" } : {}),
    });
    const out = await post!({ tool_name: "mcp__sandbox__edit", tool_input: {}, tool_response: "ok" });
    expect(out).toEqual({
      continue: true,
      decision: "block",
      reason: "lint failed",
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "2 errors" },
    });
  });
});
