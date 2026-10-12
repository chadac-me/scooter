/**
 * An agent must be able to USE its MCP tools, not merely be offered them.
 *
 * Production shipped three bugs behind that distinction: a 401 on every tunnelled call,
 * frames routed to the wrong conversation, and tools that timed out. Every one of them
 * left the OFFER intact — `/models`, the newSession payload and the picker all looked
 * right — so any assertion short of "a tool call returned" passes straight through them.
 *
 * The fake agent answers "~tools" with a real tools/list against the endpoint it was
 * offered (fakeAgent.ts), so the reply is the outcome: names if reachable, the HTTP
 * status or exception if not.
 */
import { test, expect } from "./fixtures.js";

test.describe("mcp tools", () => {
  test("OUTCOME: the agent lists real tools from its offered MCP endpoint", async ({ chat }) => {
    await chat.open();
    await chat.sendTurn("~tools");
    const reply = chat.assistantMessages().last();
    await expect(reply).toContainText(/tools\s/, { timeout: 120_000 });

    const text = (await reply.textContent()) ?? "";
    // Echo it: a PASS otherwise leaves no record of what the agent actually got,
    // so a suite that silently started listing nothing would still read green.
    console.log(`[mcp tools] ${text.trim().slice(0, 400)}`);

    expect(text, "no MCP endpoint was offered at all").not.toContain("(no MCP endpoint offered)");

    // PER TARGET. Asserting on the whole reply let a healthy scooter-env mask a
    // broker listing nothing -- the exact production shape, where the agent had
    // scooter-env tools and no contrib tools.
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
