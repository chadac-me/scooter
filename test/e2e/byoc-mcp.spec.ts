// Real tool calls, official client, real servers.
import { test, expect } from "./fixtures.js";

test.describe("mcp tools", () => {
  test("OUTCOME: scooter-env list_models returns the deployed catalog", async ({ chat, page }) => {
    await chat.open();
    // The catalog this deployment serves, so the spec holds on any tier.
    const catalog = (await (await page.request.get("/models")).json()) as { available: string[] };
    expect(catalog.available.length, "the deployment serves no models").toBeGreaterThan(0);

    await chat.sendTurn("~call scooter-env list_models");
    const reply = chat.assistantMessages().last();
    await expect(reply).toContainText("call scooter-env list_models:", { timeout: 120_000 });
    const text = (await reply.textContent()) ?? "";
    console.log(`[mcp] ${text.trim().slice(0, 400)}`);
    expect(text, "the call failed").not.toMatch(/failed:|error:|was offered/);
    for (const id of catalog.available) expect(text).toContain(id);
  });
});
