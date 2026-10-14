// A new conversation's first message is answered, whichever pod serves.
import { expect } from "@playwright/test";

import { test } from "./fixtures.js";
import { fullOnly } from "./target.js";

const ROUNDS = 6;
const BURST = 12;

fullOnly("needs several agent-host pods behind the router")("first message", () => {
  test.beforeEach(() => test.setTimeout(ROUNDS * 150_000));

  test("OUTCOME: a new conversation's first message is answered", async ({ chat, page }) => {
    await chat.open();
    for (let round = 1; round <= ROUNDS; round++) {
      const token = `FIRST-${round}-${Date.now()}`;
      const created = await page.request.post("/conversations", { data: { title: token } });
      expect(created.ok(), `create: ${created.status()}`).toBeTruthy();
      const { id } = (await created.json()) as { id: string };

      // Message and follow-up reads leave together, like the app.
      const turn = page.request.post("/agui", {
        headers: { Accept: "text/event-stream" },
        data: { threadId: id, runId: `r-${round}`, messages: [{ id: "m1", role: "user", content: token }] },
        timeout: 120_000,
      });
      const reads = Array.from({ length: BURST }, (_, i) =>
        page.request.get(`/conversations/${id}/${["tail?limit=300", "links", "ready"][i % 3]}`).catch(() => null),
      );
      await Promise.all([turn, ...reads]);

      // What the user sees on opening the conversation.
      await page.goto(`/?thread=${id}`);
      await expect(
        chat.assistantMessages().filter({ hasText: token }),
        `round ${round}: conversation ${id} lost its first reply`,
      ).toHaveCount(1, { timeout: 60_000 });
    }
  });
});
