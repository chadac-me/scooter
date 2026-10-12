// The agent must be able to USE its MCP tools, not just be offered them.
import { test, expect } from "./fixtures.js";

test.describe("mcp tools", () => {
  test("OUTCOME: the agent lists real tools from its offered MCP endpoint", async ({ chat }) => {
    await chat.open();
    await chat.sendTurn("~tools");
    const reply = chat.assistantMessages().last();
    await expect(reply).toContainText(/tools\s/, { timeout: 120_000 });

    const text = (await reply.textContent()) ?? "";
    // Printed so a pass records WHAT the agent got.
    console.log(`[mcp tools] ${text.trim().slice(0, 400)}`);

    expect(text, "no MCP endpoint was offered at all").not.toContain("(no MCP endpoint offered)");

    // Per target: a healthy one must not mask a dead one.
    const targets = Object.fromEntries(
      text.replace(/^tools\s*/, "").split("|").map((part) => {
        const [name, ...rest] = part.trim().split("=");
        return [name, rest.join("=")];
      }),
    );
    expect(Object.keys(targets).length, `no targets parsed from "${text}"`).toBeGreaterThan(0);

    for (const [name, listed] of Object.entries(targets)) {
      expect(listed, `${name}: tools/list was rejected`).not.toMatch(/\(tools\/list \d+:/);
      expect(listed, `${name}: tools/list threw`).not.toContain("threw");
      expect(listed, `${name}: listed NO tools`).not.toBe("(none)");
    }
  });
});
