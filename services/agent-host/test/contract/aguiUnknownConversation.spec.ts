/**
 * POST /agui for an id the agent-host does not have ends in a RUN_ERROR carrying
 * `code: "UNKNOWN_CONVERSATION"`. The webhooks service starts a replacement
 * conversation only on that code, so a transient run failure keeps its mapping
 * (issue #802).
 */

import { describe, it, expect } from "vitest";

import { createAguiServer } from "../../src/agui/server.js";
import { UnknownConversationError } from "../../src/session/manager.js";

async function runErrors(server: ReturnType<typeof createAguiServer>): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(`http://127.0.0.1:${server.port()}/agui`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "gone", runId: "r1", messages: [{ id: "m", role: "user", content: "x" }] }),
  });
  const body = await resp.text();
  return body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice("data:".length)))
    .filter((e) => e.type === "RUN_ERROR");
}

describe("POST /agui RUN_ERROR codes", () => {
  it("tags an unknown conversation with UNKNOWN_CONVERSATION", async () => {
    const server = createAguiServer();
    server.onPrompt(async (id) => {
      throw new UnknownConversationError(id);
    });
    await server.listen(0);
    try {
      const errors = await runErrors(server);
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("UNKNOWN_CONVERSATION");
      expect(errors[0].message).toMatch(/^No such conversation: gone/);
    } finally {
      await server.close();
    }
  });

  it("leaves any other prompt failure uncoded", async () => {
    const server = createAguiServer();
    server.onPrompt(async () => {
      throw new Error("revive failed");
    });
    await server.listen(0);
    try {
      const errors = await runErrors(server);
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
