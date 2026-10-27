/**
 * A web service link opened while its conversation is suspended: the navigation must wake the
 * sandbox, start the service and land in the real app, never a 404 or a dead end. The files
 * viewer is the service because it renders workspace data, so the page proves it loaded.
 */
import { expect, type Page, type Response } from "@playwright/test";

import { test } from "./fixtures.js";
import { fullOnly } from "./target.js";

/** The agent-host's manifest cache lifetime (webServiceRegistry.ts MANIFEST_TTL_MS). */
const MANIFEST_TTL_MS = 10_000;

/** Parent domain of the per-conversation service origins, set when the platform has them on. */
const SANDBOX_DOMAIN = process.env.E2E_SANDBOX_DOMAIN ?? "";

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
    // Service links point at the conversation's own host, so that is the address under test.
    test.skip(!SANDBOX_DOMAIN, "the platform has no ingress.sandboxDomain");

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

      // The link the agent hands out: the conversation's dedicated host, not /c/<id>/ on the main one.
      const origin = `https://${thread!.slice(0, 8)}.${SANDBOX_DOMAIN}`;
      const filesUrl = `${origin}/files/`;
      const viewer = await page.context().newPage();
      const tree = (p: Page) => p.getByRole("button", { name: fileName });

      // Start the service once while awake, so the wake below has to bring a used service back.
      await viewer.goto(filesUrl);
      await expect(tree(viewer)).toBeVisible({ timeout: 300_000 });
      expect(viewer.url()).toBe(filesUrl);
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
      // Still on the conversation's own host: no bounce to the main host or another conversation.
      expect(page2.url()).toBe(filesUrl);
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
      const offHost = navigations.filter((n) => new URL(n.url).origin !== origin);
      expect(offHost, "every navigation must stay on the conversation's own host").toEqual([]);
    });

    test("a link opened after the sandbox has gone cold still wakes it", async ({ chat, page, request, baseURL }) => {
      // One sandbox boot and one wake.
      test.setTimeout(420_000);
      const base = (baseURL ?? "").replace(/\/$/, "");
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const fileName = `cold-wake-${stamp}.md`;

      await chat.open();
      await chat.completeTurn(`!touch /workspace/${fileName}`, 120_000);
      const thread = new URL(page.url()).searchParams.get("thread");
      expect(thread, "the URL must name a conversation").toBeTruthy();
      const id = encodeURIComponent(thread!);
      await expect
        .poll(async () => {
          const res = await request.get(`${base}/conversations/${id}/web-services`);
          return res.ok() ? ((await res.json()) as { services: Array<{ name: string }> }).services.map((s) => s.name) : [];
        }, { timeout: 120_000 })
        .toContain("files");

      const suspended = await request.post(`${base}/conversations/${id}/suspend`);
      expect(suspended.ok(), `suspend answered ${suspended.status()}`).toBeTruthy();
      await expect
        .poll(async () => ((await (await request.get(`${base}/conversations/${id}`)).json()) as { status: string }).status, {
          timeout: 60_000,
        })
        .toBe("suspended");
      // Outlive the agent-host's manifest cache, as a link opened later would.
      await page.waitForTimeout(MANIFEST_TTL_MS + 5_000);

      const origin = `https://${thread!.slice(0, 8)}.${SANDBOX_DOMAIN}`;
      const filesUrl = `${origin}/files/`;
      const viewer = await page.context().newPage();
      const navigations = recordNavigations(viewer);
      // Under the ingress's 30s upstream timeout, so a hang fails here, not as a 502.
      const first = await viewer.goto(filesUrl, { timeout: 20_000 });
      expect(first?.status() ?? 0, `the first navigation answered ${first?.status()}`).toBeLessThan(400);

      await expect(viewer.getByRole("button", { name: fileName })).toBeVisible({ timeout: 360_000 });
      expect(viewer.url()).toBe(filesUrl);
      const failed = navigations.filter((n) => n.status >= 400);
      expect(failed, "no navigation along the wake → start → reload path may fail").toEqual([]);
    });
  },
);
