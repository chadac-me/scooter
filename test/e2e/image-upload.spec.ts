/**
 * Tier 3 E2E for a composer image attachment reaching the agent process. @assistant-ui's
 * composer puts each attached image in a separate `message.attachments[]` rather than in
 * `message.content`, so only driving the real composer proves the wiring. Two independent
 * proofs: the outgoing POST /agui body carries an image content part, and the fake agent's
 * `~images` directive reports images=1, proving the image survived the whole pipe to the
 * agent process.
 */

import { test, expect } from "./fixtures.js";

// A minimal valid 1x1 transparent PNG, under the size cap and an allowed MIME type.
const PNG_1x1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test.describe("image upload", () => {
  test("an attached image reaches the agent process (not dropped in the composer)", async ({
    chat,
    page,
  }) => {
    await chat.open();

    // Capture the outgoing POST /agui body (proof #1, the wire).
    let aguiBody: string | null = null;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().endsWith("/agui")) {
        aguiBody = req.postData();
      }
    });

    // Attach the image via the real composer, whose native file chooser Playwright drives
    // through the filechooser event.
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByLabel("Add Attachment").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "shot.png",
      mimeType: "image/png",
      buffer: Buffer.from(PNG_1x1_BASE64, "base64"),
    });

    // The staged attachment renders a preview thumbnail in the composer.
    await expect(page.getByRole("img", { name: /attachment preview/i }).first()).toBeVisible({
      timeout: 15_000,
    });

    // Send with the ~images directive, clicking Send explicitly because a staged attachment
    // plus Enter is less reliable.
    const input = page.getByRole("textbox", { name: "Message input" });
    await input.click();
    await input.fill("~images");
    await page.getByRole("button", { name: /send message/i }).click();

    // The send must land in the viewed thread.
    await expect(chat.userMessages().last()).toContainText("~images", { timeout: 20_000 });

    // Proof #2, the process: the image block made it all the way to the agent.
    await expect(chat.assistantMessages().last()).toContainText(/images=1/, {
      timeout: 45_000,
    });

    // Proof #1, the wire: the POST /agui body carried an image part.
    console.log("[image-upload] aguiBody:", aguiBody?.slice(0, 300));
    expect(aguiBody, "a POST /agui should have been observed").not.toBeNull();
    const parsed = JSON.parse(aguiBody!) as {
      messages?: Array<{ content?: unknown }>;
    };
    const parts = parsed.messages?.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Array<{ type?: string }>) : [],
    );
    expect(parts?.some((p) => p?.type === "image")).toBe(true);
  });
});
