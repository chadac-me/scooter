/**
 * A conversation never waits on its sandbox pod. The fake stack holds the sandbox of a
 * cold-pod-* owner for FAKE_SANDBOX_COLD_MS (8s): creating the conversation and sending to
 * it must land at once, and only the reply waits for the pod.
 */
import type { Browser, Page } from "@playwright/test";

import { Chat, expect, test } from "./fixtures.js";
import { fastOnly } from "./target.js";

/** Matches FAKE_SANDBOX_COLD_MS in support/fakeBackend.mjs. */
const COLD_MS = 8_000;
/** Well inside the hold, so passing it means nothing waited for the pod. */
const PROMPT_MS = 3_000;

async function coldPodUser(browser: Browser): Promise<Page> {
  const user = `cold-pod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const context = await browser.newContext({ extraHTTPHeaders: { "x-auth-user": user } });
  return context.newPage();
}

/** Creates a conversation, failing if the request waited for the pod; the first prompt provisions it. */
async function createCold(page: Page): Promise<string> {
  const t0 = Date.now();
  const res = await page.request.post("/conversations", { data: {} });
  expect(res.ok(), `create: ${res.status()}`).toBeTruthy();
  expect(Date.now() - t0, "POST /conversations waited for the sandbox").toBeLessThan(PROMPT_MS);
  return ((await res.json()) as { id: string }).id;
}

fastOnly("the cold-pod hold is a fake-sandbox knob")("cold sandbox pod", () => {
  test.beforeEach(() => test.setTimeout(90_000));

  test("OUTCOME: the first message posts at once and is answered once the pod is up", async ({ browser }) => {
    const page = await coldPodUser(browser);
    try {
      const chat = new Chat(page);
      const id = await createCold(page);
      const created = Date.now();
      await page.goto(`/?thread=${id}`);
      await expect(chat.input()).toBeVisible({ timeout: 20_000 });

      const token = `COLD-${Date.now()}`;
      await chat.send(token);
      await expect(chat.userMessages().filter({ hasText: token })).toHaveCount(1, { timeout: PROMPT_MS });

      // The reply needs the pod, so it cannot beat the hold; seeing it early means no hold ran.
      const reply = chat.assistantMessages().filter({ hasText: token });
      await expect(reply.first()).toBeVisible({ timeout: COLD_MS + 30_000 });
      expect(Date.now() - created, "the reply arrived before the pod came up").toBeGreaterThanOrEqual(COLD_MS - 500);
    } finally {
      await page.context().close();
    }
  });

  test("OUTCOME: a message with a file attached posts without waiting for the pod", async ({ browser }) => {
    const page = await coldPodUser(browser);
    try {
      const chat = new Chat(page);
      const id = await createCold(page);
      await page.goto(`/?thread=${id}`);
      await expect(chat.input()).toBeVisible({ timeout: 20_000 });

      const chooser = page.waitForEvent("filechooser");
      await page.getByLabel("Add Attachment").click();
      await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("cold pod upload\n") });

      const token = `COLD-FILE-${Date.now()}`;
      const input = page.getByRole("textbox", { name: "Message input" });
      await input.click();
      await input.fill(token);
      await page.getByRole("button", { name: /send message/i }).click();
      await expect(chat.userMessages().filter({ hasText: token })).toHaveCount(1, { timeout: PROMPT_MS });

      // The fake agent echoes the upload note, so the reply names the written file.
      await expect(chat.assistantMessages().filter({ hasText: "/workspace/uploads/notes.txt" }).first()).toBeVisible({
        timeout: COLD_MS + 30_000,
      });
    } finally {
      await page.context().close();
    }
  });
});
