/**
 * A web service link opened while its conversation is suspended: the navigation must wake the
 * sandbox, start the service and land in the real app, never a 404 or a dead end. The files
 * viewer is the service because it renders workspace data, so the page proves it loaded.
 */
import { expect, type Page, type Response } from "@playwright/test";

import { test } from "./fixtures.js";
import { fullOnly } from "./target.js";

/** Records every main-frame document response, so a 404 anywhere in the redirect/reload chain fails the test. */
function recordNavigations(page: Page): Array<{ url: string; status: number }> {
  const seen: Array<{ url: string; status: number }> = [];
  page.on("response", (res: Response) => {
    if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) {
      seen.push({ url: res.url(), status: res.status() });
    }
  });
  return seen;
}

fullOnly("needs a real sandbox pod to suspend and a real web service to auto-start")(
  "opening a web service on a suspended sandbox",
  () => {
    test("the files viewer wakes the sandbox, auto-starts and shows the workspace", async ({
      chat,
      page,
      request,
      baseURL,
    }) => {
      // Two sandbox boots and two starts of the files unit.
      test.setTimeout(480_000);
      const base = (baseURL ?? "").replace(/\/$/, "");
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fileName = `suspend-wake-${stamp}.md`;
      const fileBody = `written before the nap ${stamp}`;

      // The marker lives on the workspace PVC, so seeing it after the wake shows real data.
      await chat.open();
      await chat.completeTurn(`!printf '%s\\n' '${fileBody}' > /workspace/${fileName}`, 120_000);
      const thread = new URL(page.url()).searchParams.get("thread");
      expect(thread, "the URL must name a conversation").toBeTruthy();
      const id = encodeURIComponent(thread!);

      // Boot renders the manifest after the turn can finish, so wait until `files` is declared.
      await expect
        .poll(async () => {
          const res = await request.get(`${base}/conversations/${id}/web-services`);
          return res.ok() ? ((await res.json()) as { services: Array<{ name: string }> }).services.map((s) => s.name) : [];
        }, { timeout: 120_000 })
        .toContain("files");

      const filesUrl = `${base}/c/${id}/files/`;
      const viewer = await page.context().newPage();
      const tree = (p: Page) => p.getByRole("button", { name: fileName });

      // Start the service once while awake, so the wake below has to bring a used service back.
      await viewer.goto(filesUrl);
      await expect(tree(viewer)).toBeVisible({ timeout: 300_000 });
      await viewer.close();

      const suspended = await request.post(`${base}/conversations/${id}/suspend`);
      expect(suspended.ok(), `suspend answered ${suspended.status()}`).toBeTruthy();
      await expect
        .poll(async () => ((await (await request.get(`${base}/conversations/${id}`)).json()) as { status: string }).status, {
          timeout: 60_000,
        })
        .toBe("suspended");

      // The suspended pod is gone, so the first answer is the loading page, which wakes and starts it.
      const page2 = await page.context().newPage();
      const navigations = recordNavigations(page2);
      const first = await page2.goto(filesUrl);
      expect(first?.status(), "a suspended sandbox's service must not 404").not.toBe(404);
      expect(first?.status() ?? 0, `the first navigation answered ${first?.status()}`).toBeLessThan(400);

      // The real viewer, listing the workspace from the woken pod.
      await expect(tree(page2)).toBeVisible({ timeout: 360_000 });
      await expect(page2).toHaveTitle("Files");
      await expect(page2.getByText(/^Starting files/)).toHaveCount(0);

      // And it reads a file's contents, not just the listing.
      await tree(page2).click();
      await expect(page2.getByText(fileBody).first()).toBeVisible({ timeout: 30_000 });

      const health = await page2.evaluate(async () => {
        const viewerBase = (window as unknown as { __BASE__?: string }).__BASE__ ?? "";
        const res = await fetch(`${viewerBase}/api/health`, { cache: "no-store" });
        return { status: res.status, body: res.ok ? ((await res.json()) as { ok: boolean; frontend: boolean }) : null };
      });
      expect(health.status, "the viewer's own API must answer").toBe(200);
      expect(health.body).toMatchObject({ ok: true, frontend: true });

      const failed = navigations.filter((n) => n.status >= 400);
      expect(failed, "no navigation along the wake → start → reload path may fail").toEqual([]);
    });
  },
);
