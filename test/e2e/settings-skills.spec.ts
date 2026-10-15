/**
 * Tier 3 E2E for personal skills: the Skills settings tab round-trips a skill the user
 * authors — create, toggle, edit, delete — through the real agent-host and its database.
 *
 * Every skill is named per-run (`e2e-skill-<n>`) and deleted at the end, because the stack
 * is shared and the owner+name pair is unique: a leftover row would fail the next run's
 * create rather than its own.
 *
 * Runs on both targets, and the full one is not redundant: only there do the requests pass
 * through the production nginx, whose proxy allowlist is a different file from the vite dev
 * proxy the fast stack uses — a path missing from it answers the SPA with a 200 and the
 * feature is inert while every unit test stays green. The full-only block at the bottom
 * covers what a real conversation start adds on top.
 */

import { type Page } from "@playwright/test";
import { test, expect, snapshot, assertConsistent } from "./fixtures.js";
import { fullOnly } from "./target.js";

/** A name no other run holds, since one owner cannot have two skills with the same name. */
const uniqueName = () => `e2e-skill-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function openSkills(page: Page) {
  await page.goto("/settings/skills");
  await expect(page.locator('[data-testid="settings-panel-skills"]')).toBeVisible({ timeout: 20_000 });
}

/** The row for `name`, which is how the list identifies a skill to the user. */
const rowFor = (page: Page, name: string) =>
  page.locator('[data-testid="skill-item"]').filter({ has: page.locator(`text="${name}"`) });

/** Fill the open form and submit it. */
async function fillForm(page: Page, v: { name?: string; description?: string; body?: string }) {
  if (v.name !== undefined) await page.locator('[data-testid="skill-name"]').fill(v.name);
  if (v.description !== undefined) await page.locator('[data-testid="skill-description"]').fill(v.description);
  if (v.body !== undefined) await page.locator('[data-testid="skill-body"]').fill(v.body);
  await page.locator('[data-testid="skill-submit"]').click();
}

test.describe("settings — personal skills", () => {
  test.setTimeout(120_000);

  test("the tab renders a usable section, never a blank panel", async ({ page }) => {
    await openSkills(page);
    const text = (await page.locator('[data-testid="settings-panel-skills"]').innerText()).trim();
    expect(text.length, "the skills tab must never render blank").toBeGreaterThan(40);
    // Either the feature is live (a New button) or it says why it is not; never nothing.
    const live = page.locator('[data-testid="skill-new"]');
    const off = page.locator('[data-testid="skills-unavailable"]');
    await expect(live.or(off).first()).toBeVisible({ timeout: 20_000 });
  });

  test("a skill the user writes survives create, toggle, edit and delete", async ({ page }) => {
    await openSkills(page);
    // This deployment has a database or the rest of the test has nothing to drive.
    await expect(page.locator('[data-testid="skill-new"]')).toBeVisible({ timeout: 20_000 });

    const name = uniqueName();
    await page.locator('[data-testid="skill-new"]').click();
    await fillForm(page, {
      name,
      description: "Conventions for the acme/app repo. Use when working in acme/app.",
      body: "# Acme\n\nRun `make check` before pushing.",
    });

    const row = rowFor(page, name);
    await expect(row, "the new skill appears in the list").toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute("data-enabled", "true");

    // Disabling is what keeps a skill out of the next conversation's prompt, so it has to
    // round-trip to the server rather than only flipping in the DOM.
    await row.locator('[data-testid="skill-toggle"]').click();
    await expect(rowFor(page, name)).toHaveAttribute("data-enabled", "false", { timeout: 20_000 });
    await page.reload();
    await expect(page.locator('[data-testid="settings-panel-skills"]')).toBeVisible({ timeout: 20_000 });
    await expect(rowFor(page, name), "the toggle persisted").toHaveAttribute("data-enabled", "false", {
      timeout: 20_000,
    });

    // Editing the description matters most: it is what the agent matches on.
    await rowFor(page, name).locator('[data-testid="skill-edit"]').click();
    await fillForm(page, { description: "Use when reviewing a PR in acme/app." });
    await expect(rowFor(page, name)).toContainText("Use when reviewing a PR in acme/app.", { timeout: 20_000 });

    // Delete, confirming the browser dialog the row raises.
    page.once("dialog", (d) => void d.accept());
    await rowFor(page, name).locator('[data-testid="skill-delete"]').click();
    await expect(rowFor(page, name)).toHaveCount(0, { timeout: 20_000 });
  });

  test("a rejected name shows the server's reason and keeps the form open", async ({ page }) => {
    // The name becomes a path segment in the agent's skills directory, so it is validated
    // server-side; the user has to see why rather than watch the save quietly fail.
    await openSkills(page);
    await expect(page.locator('[data-testid="skill-new"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="skill-new"]').click();
    await fillForm(page, { name: "Not A Valid Name", description: "when testing", body: "body" });

    await expect(page.locator('[data-testid="skill-form-error"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="skill-form-error"]')).toContainText(/name/i);
    // Still open, with the user's text intact — a cleared form loses their work.
    await expect(page.locator('[data-testid="skill-body"]')).toHaveValue("body");
    await page.locator('[data-testid="skill-cancel"]').click();
  });

  test("a name that shadows a built-in skill warns before it is saved", async ({ page }) => {
    // Shadowing is allowed (your copy wins) but silently replacing a platform skill is the
    // kind of surprise that costs an afternoon.
    await openSkills(page);
    await expect(page.locator('[data-testid="skill-new"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="skill-new"]').click();
    await page.locator('[data-testid="skill-name"]').fill("scooter-intro");
    await expect(page.locator('[data-testid="skill-shadow-warning"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="skill-cancel"]').click();
  });
});

/**
 * What a real cluster adds: the production nginx in front of the routes, and a conversation
 * start that actually boots an agent while a personal skill is in the owner's row set.
 *
 * On the fast stack the agent is a script that never reads a prompt, so "injection did not
 * break the run" is a statement only this target can make.
 */
fullOnly("needs the production nginx and a real agent boot")("personal skills on a real cluster", () => {
  test("a conversation still starts and answers with a personal skill injected", async ({ chat, page }) => {
    // A cold sandbox boot plus a turn, on top of the CRUD round trip.
    test.setTimeout(300_000);

    const name = uniqueName();
    await openSkills(page);
    await expect(page.locator('[data-testid="skill-new"]'), "personal skills need the agent_host DB").toBeVisible({
      timeout: 30_000,
    });
    await page.locator('[data-testid="skill-new"]').click();
    await fillForm(page, {
      name,
      description: `Test skill ${name}. Use when the user mentions ${name}.`,
      body: `# ${name}\n\nThis skill exists to prove injection does not break a conversation.`,
    });
    await expect(rowFor(page, name)).toBeVisible({ timeout: 30_000 });

    try {
      // The host reads the owner's skills and writes them before the agent is built, so a
      // failure in that path shows up here as a conversation that never answers.
      await chat.open();
      await chat.completeTurn("say hello");
      const after = await snapshot(page);
      expect(after.assistantMessages, "the agent answered with a personal skill injected").toBeGreaterThan(0);
      assertConsistent(after, "turn with a personal skill injected");
    } finally {
      // Always clean up: the name is unique per run, but rows accumulate on a live cluster.
      await openSkills(page);
      page.once("dialog", (d) => void d.accept());
      await rowFor(page, name).locator('[data-testid="skill-delete"]').click();
      await expect(rowFor(page, name)).toHaveCount(0, { timeout: 30_000 });
    }
  });
});
