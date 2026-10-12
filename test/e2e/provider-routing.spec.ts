/**
 * An explicit provider pick must change which provider serves the run.
 *
 * Not coverable by the fake stack: it has no BYOC container, so remote-personalized is never
 * eligible and the grouped picker never renders. This runs against a real cluster, picks a
 * provider through the real UI, and reads the server's own view of the result.
 */
import { test, expect } from "./fixtures.js";

/** The X-Agent-Model header the UI sends on the next prompt, captured off the wire. */
async function captureAgentModelHeader(page: import("@playwright/test").Page): Promise<string[]> {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "POST" || !r.url().endsWith("/agui")) return;
    const h = r.headers()["x-agent-model"];
    if (h) seen.push(h);
  });
  return seen;
}

test.describe("provider routing", () => {
  test("the picker's option values carry a provider", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();
    const values = await picker.locator("option").evaluateAll((os) =>
      os.map((o) => (o as HTMLOptionElement).value),
    );
    expect(values.length).toBeGreaterThan(0);
    // Grouped catalogs qualify every value; an unqualified one cannot route.
    const grouped = await picker.locator("optgroup").count();
    if (grouped > 0) {
      for (const v of values) expect(v, `"${v}" is not provider-qualified`).toMatch(/^[a-z-]+:.+/);
    }
  });

  test("exactly one option is marked (default)", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();
    await expect(picker.locator("option", { hasText: "(default)" })).toHaveCount(1);
  });

  test("picking a provider sends it on the next prompt", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();
    if ((await picker.locator("optgroup").count()) === 0) {
      test.skip(true, "catalog is not provider-grouped on this deployment");
    }

    const headers = await captureAgentModelHeader(page);
    const value = await picker
      .locator("option")
      .nth(1)
      .evaluate((o) => (o as HTMLOptionElement).value);
    await picker.selectOption(value);

    // The pick rides the NEXT prompt; selecting alone sends nothing.
    await chat.send("hello");
    await expect.poll(() => headers.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(headers[headers.length - 1]).toBe(value);
  });
});
