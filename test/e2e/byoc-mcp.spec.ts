// Real tool calls, official client, real servers.
import { test, expect } from "./fixtures.js";

test.describe("mcp tools", () => {
  test("OUTCOME: scooter-env list_models returns the deployed catalog", async ({ chat }) => {
    await chat.open();
    await chat.sendTurn("~call scooter-env list_models");
    const reply = chat.assistantMessages().last();
    await expect(reply).toContainText("call scooter-env list_models:", { timeout: 120_000 });
    const text = (await reply.textContent()) ?? "";
    console.log(`[mcp] ${text.trim().slice(0, 400)}`);
    expect(text, "the call failed").not.toMatch(/failed:|error:|was offered/);
    // From test-platform.nix's catalog, so it proves the server answered.
    expect(text).toContain("model-shared");
  });
});
