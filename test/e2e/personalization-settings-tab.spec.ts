/**
 * Tier 3 E2E for the personalization contrib's settings tab: it renders from the
 * manifest, shows its error card while the broker routes are unreachable, and drives
 * the profile and notes through the /contrib-api routes. The fast stack runs no broker,
 * so those routes are an in-memory stand-in at the browser.
 */

import { type Page, type Route } from "@playwright/test";
import { test, expect } from "./fixtures.js";

const TAB = { contrib: "personalization", label: "Personalization", order: 45, entry: "personalization/ui/SettingsTab.tsx" };

async function serveTab(page: Page) {
  await page.route("**/contrib/manifest.json", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sources: {}, toolCards: {}, toolTitles: {}, linkProviders: [], approvals: {},
        settingsTabs: { personalization: TAB },
      }),
    }),
  );
}

interface Note { id: string; category: string; note: string; source: "agent" | "user"; pinned: boolean; updated_at: string }

/** The broker's /user/* routes, held in memory. Returns the request log. */
async function fakeBroker(page: Page, seed: Note[] = []) {
  const profile = { enabled: true, last_analyzed_at: null as string | null, refresh_requested_at: null as string | null, last_run_conversation: null };
  let notes = [...seed];
  let next = notes.length;
  const calls: string[] = [];
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/contrib-api/personalization/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/contrib-api/personalization/", "");
    const body = req.postData() ? JSON.parse(req.postData()!) : {};
    calls.push(`${req.method()} ${path}`);
    const now = new Date().toISOString();
    if (path === "profile" && req.method() === "GET") return json(route, { profile });
    if (path === "profile" && req.method() === "PATCH") { profile.enabled = body.enabled; return json(route, { profile }); }
    if (path === "refresh") { profile.refresh_requested_at = now; return json(route, { profile }); }
    if (path === "notes" && req.method() === "GET") return json(route, { notes });
    if (path === "notes" && req.method() === "POST") {
      const n: Note = { id: `n${next++}`, category: body.category, note: body.note, source: "user", pinned: false, updated_at: now };
      notes.push(n);
      return json(route, { note: n }, 201);
    }
    if (path === "notes" && req.method() === "DELETE") { notes = []; return json(route, { deleted: true }); }
    const m = path.match(/^notes\/(.+)$/);
    if (m) {
      const n = notes.find((x) => x.id === m[1]);
      if (!n) return json(route, { detail: "not found" }, 404);
      if (req.method() === "DELETE") { notes = notes.filter((x) => x !== n); return json(route, { deleted: true }); }
      Object.assign(n, body, { updated_at: now });
      return json(route, { note: n });
    }
    return json(route, { detail: "unexpected" }, 500);
  });
  return calls;
}

const tab = (page: Page) => page.locator('[data-testid="personalization-settings-tab"]');
const notes = (page: Page) => page.locator('[data-testid="personalization-note"]');

test.describe("personalization settings tab", () => {
  test("shows its error card while the broker routes are unavailable", async ({ page }) => {
    await serveTab(page);
    await page.route("**/contrib-api/personalization/**", (route) =>
      route.fulfill({ status: 501, contentType: "text/plain", body: "not implemented" }),
    );
    await page.goto("/settings/personalization");
    await expect(page.getByText("Couldn't load your profile")).toBeVisible({ timeout: 20_000 });
    // The rest of Settings still works.
    await expect(page.locator('[data-testid="settings-tab-personalization"]')).toHaveAttribute("aria-selected", "true");
  });

  test("lists notes by category and adds, pins, edits and deletes one", async ({ page }) => {
    await serveTab(page);
    const calls = await fakeBroker(page, [
      { id: "a1", category: "agent-habits", note: "Runs the full suite before a one-file change", source: "agent", pinned: false, updated_at: "2026-10-01T00:00:00Z" },
    ]);
    await page.goto("/settings/personalization");
    await expect(tab(page)).toBeVisible({ timeout: 20_000 });
    await expect(tab(page).getByRole("heading", { name: "Things agents repeatedly do" })).toBeVisible();
    await expect(notes(page)).toHaveCount(1);
    await expect(notes(page).first()).toContainText("from analysis");

    await tab(page).getByLabel("New note").fill("Open PRs as drafts first");
    await tab(page).getByRole("button", { name: "Add", exact: true }).click();
    await expect(notes(page)).toHaveCount(2);
    const mine = notes(page).filter({ hasText: "Open PRs as drafts first" });
    await expect(mine).toContainText("yours");

    await mine.getByRole("button", { name: "Pin" }).click();
    await expect(mine).toContainText("pinned");

    await mine.getByRole("button", { name: "Edit" }).click();
    // While editing, the text sits in a textarea, which hasText does not see.
    const editing = notes(page).filter({ has: page.locator("textarea") });
    await editing.locator("textarea").fill("Open PRs as drafts, always");
    await editing.getByRole("button", { name: "Save" }).click();
    await expect(notes(page).filter({ hasText: "Open PRs as drafts, always" })).toHaveCount(1);

    await notes(page).filter({ hasText: "Open PRs as drafts, always" }).getByRole("button", { name: "Delete" }).click();
    await expect(notes(page)).toHaveCount(1);

    expect(calls).toEqual(expect.arrayContaining(["POST notes", "PATCH notes/n1", "DELETE notes/n1"]));
  });

  test("opting out disables Refresh now, a refresh greys it out until it runs, and Delete all empties the profile", async ({ page }) => {
    await serveTab(page);
    const calls = await fakeBroker(page, [
      { id: "a1", category: "preferences", note: "Prefers short replies", source: "agent", pinned: false, updated_at: "2026-10-01T00:00:00Z" },
    ]);
    await page.goto("/settings/personalization");
    const refresh = tab(page).getByRole("button", { name: "Refresh now" });
    await expect(refresh).toBeEnabled({ timeout: 20_000 });
    // A controlled checkbox: it flips once the PATCH and reload land, so click and wait.
    const toggle = tab(page).getByLabel("Analyse my conversations");
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(refresh).toBeDisabled();
    await toggle.click();
    await expect(toggle).toBeChecked();

    await refresh.click();
    await expect(tab(page).getByRole("button", { name: "Refresh queued" })).toBeDisabled();
    await expect(tab(page)).toContainText("refresh queued, starts within the hour");

    page.once("dialog", (d) => void d.accept());
    await tab(page).getByRole("button", { name: "Delete all notes" }).click();
    await expect(page.getByText("No notes yet")).toBeVisible();
    expect(calls).toEqual(expect.arrayContaining(["POST refresh", "PATCH profile", "DELETE notes"]));
  });
});
