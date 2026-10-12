// Picking a provider must change which provider serves the turn.
import { test, expect } from "./fixtures.js";

/** Option values, per provider group. */
async function optionsByGroup(page: import("@playwright/test").Page) {
  return page.getByTestId("model-picker").locator("optgroup").evaluateAll((gs) =>
    gs.map((g) => ({
      provider: (g as HTMLOptGroupElement).label,
      values: [...g.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value),
    })),
  );
}

test.describe("provider routing", () => {
  test("the catalog groups by provider and qualifies every value", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();

    const groups = await optionsByGroup(page);
    // Fail, not skip: ungrouped makes the suite vacuous.
    expect(groups.length, "the catalog is not provider-grouped").toBeGreaterThan(1);
    for (const g of groups) {
      for (const v of g.values) expect(v, `"${v}" is not provider-qualified`).toMatch(/^[a-z-]+:.+/);
    }
  });

  test("exactly one option is marked (default)", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();
    await expect(picker.locator("option", { hasText: "(default)" })).toHaveCount(1);
  });

  test("OUTCOME: the picked provider's model is the one that runs", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();

    // Exclusive to one provider, so the outcome is unambiguous.
    const groups = await optionsByGroup(page);
    const counts = new Map<string, number>();
    for (const g of groups) {
      for (const v of g.values) {
        const id = v.slice(v.indexOf(":") + 1);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    const exclusive = groups
      .flatMap((g) => g.values)
      .find((v) => counts.get(v.slice(v.indexOf(":") + 1)) === 1);
    expect(exclusive, "no provider-exclusive model to route with").toBeTruthy();

    const picked = exclusive!;
    const expectedModel = picked.slice(picked.indexOf(":") + 1);
    await picker.selectOption(picked);

    // THE OUTCOME. The fake agent reports the model it was launched with, so this
    await chat.sendTurn("~model");
    await expect(chat.assistantMessages().last()).toContainText(`model=${expectedModel}`, {
      timeout: 120_000,
    });
  });
});
