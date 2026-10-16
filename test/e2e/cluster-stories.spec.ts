/**
 * User stories that only a real cluster can express: the fake stack has one agent-host,
 * no router and no rollout, so it cannot express multi-pod routing or a deploy landing
 * mid-turn. Everything else worth running against a cluster is an existing spec selected
 * through the `cluster` project, so do not duplicate it here.
 */
import { expect } from "@playwright/test";

import { test } from "./fixtures.js";
import { fullOnly } from "./target.js";

fullOnly("needs multiple agent-host pods behind the router")(
  "multi-pod conversation routing",
  () => {
    // Every turn here execs in a real sandbox and completeTurn's default is 120s on this
    // target, so the suite ceiling is too low.
    test.beforeEach(() => test.setTimeout(300_000));

    test("a conversation stays reachable no matter which pod the router picks", async ({ chat, page }) => {
      await chat.open();
      await chat.completeTurn("first turn");
      const url = page.url();

      // Re-entering through the front door may land on a different pod than the owner, and
      // the router must still reach the owning pod.
      for (let i = 0; i < 3; i++) {
        await page.goto(url);
        await expect(chat.input()).toBeVisible({ timeout: 30_000 });
        await expect(chat.userMessages().first()).toBeVisible({ timeout: 30_000 });
      }

      // And it must still be live, not merely readable.
      await chat.completeTurn("second turn after re-routing");
      await expect.poll(async () => chat.userMessages().count(), { timeout: 30_000 }).toBe(2);
    });
  },
);

fullOnly("needs a real rollout to restart pods under a live conversation")(
  "a deploy during a live conversation",
  () => {
    // Same reasoning as the describe above, plus a real rollout in the middle.
    test.beforeEach(() => test.setTimeout(300_000));

    test("a conversation survives its host pod being replaced", async ({ chat, page, request }) => {
      // A rollout landing seconds after a conversation was created must not kill its stream
      // or lose it on refresh.
      await chat.open();
      await chat.completeTurn("before the rollout");
      const url = page.url();
      const thread = new URL(url).searchParams.get("thread");
      expect(thread, "the URL must name a conversation").toBeTruthy();

      // Restart agent-host out of band (the CI job grants kubectl access).
      const restarted = await request.post(`${process.env.E2E_ROLLOUT_HOOK ?? ""}/restart`).catch(() => null);
      test.skip(!restarted?.ok(), "no rollout hook configured for this run");

      await page.goto(url);
      await expect(chat.input()).toBeVisible({ timeout: 60_000 });

      // The conversation must still exist, still be named by the URL, and still work.
      expect(new URL(page.url()).searchParams.get("thread")).toBe(thread);
      await expect(chat.userMessages().first()).toBeVisible({ timeout: 60_000 });
      await chat.completeTurn("after the rollout");
    });
  },
);

fullOnly("needs kubectl access to delete the owner pod mid-run")(
  "the conversation MOVES pods mid-run",
  () => {
    test("the owner pod dies mid-run; the UI recovers and keeps communicating", async ({ chat, page, request }) => {
      // The pod hosting a live run is deleted under it; the controller must reassign, the
      // new owner must revive the stranded run, and the same browser tab must end up idle
      // and able to run another turn.
      test.setTimeout(300_000);
      const hook = process.env.E2E_ROLLOUT_HOOK ?? "";
      test.skip(!hook, "no rollout hook configured for this run");

      await chat.open();
      await chat.completeTurn("before the move", 100_000);
      const thread = new URL(page.url()).searchParams.get("thread");
      expect(thread, "the URL must name a conversation").toBeTruthy();

      // A turn long enough that the pod deletion lands mid-run.
      await chat.send("!sleep 15");
      await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
      const moved = await request.post(`${hook}/move/${thread}`);
      expect(moved.ok(), `the hook must delete the owner pod: ${await moved.text()}`).toBeTruthy();

      // The run must reach a terminal state within the reassign + revive + resume budget.
      await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: 180_000 });

      // And the conversation is still this conversation, still alive.
      expect(new URL(page.url()).searchParams.get("thread")).toBe(thread);
      await chat.completeTurn("after the move", 100_000);
    });
  },
);

fullOnly("needs a real sandbox pod and its declared web services behind the router")(
  "opening a web service from the browser",
  () => {
    test("the services list is right and a stopped service lands in the app", async ({ chat, page, request, baseURL }) => {
      // The first start of `terminal` builds ttyd in-pod, on top of a real sandbox boot. PR #799.
      test.setTimeout(420_000);
      const base = (baseURL ?? "").replace(/\/$/, "");

      await chat.open();
      await chat.completeTurn("bring the sandbox up", 100_000);
      const thread = new URL(page.url()).searchParams.get("thread");
      expect(thread, "the URL must name a conversation").toBeTruthy();

      // Whichever pod answers must list the image's services, not a stale empty set.
      for (let i = 0; i < 5; i++) {
        const res = await request.get(`${base}/conversations/${encodeURIComponent(thread!)}/web-services`);
        expect(res.ok(), `web-services answered ${res.status()}`).toBeTruthy();
        const names = ((await res.json()) as { services: Array<{ name: string }> }).services.map((s) => s.name);
        expect(names).toContain("terminal");
      }

      // A stopped service gets the loading page, whose poll starts it and reloads into ttyd.
      await page.goto(`${base}/c/${encodeURIComponent(thread!)}/terminal/`);
      await expect(page.locator(".xterm")).toBeVisible({ timeout: 300_000 });
    });
  },
);
