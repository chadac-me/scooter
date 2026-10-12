/**
 * Tier 3 E2E for one scenario with the real `goose acp` binary and a real sandbox, proving
 * the actual agent integrates end to end (ACP -> bridge -> AG-UI -> UI, and ACP terminal/fs
 * -> agent-sandbox exec). Non-deterministic and needs a model provider and a cluster, so it
 * is gated on RUN_REAL_GOOSE=1 (plus GOOSE_PROVIDER/GOOSE_MODEL/AWS_*) and asserted loosely.
 */

import { test, expect } from "./fixtures.js";
import { fastOnly } from "./target.js";

const run = process.env.RUN_REAL_GOOSE === "1";

// Env-gated everywhere and not in the full-target allowlist: CI's k3d cluster runs the fake
// agent, so running this there would test the fake agent under a "real goose" name.
const maybe = run
  ? test.describe
  : fastOnly(
      "needs the real goose binary + a model provider — CI's full-target cluster runs GOOSE_BIN=fake; run manually with RUN_REAL_GOOSE=1 + Bedrock creds",
    );

maybe(run ? "real goose" : "real goose (skipped)", () => {
  test.skip(!run, "set RUN_REAL_GOOSE=1 + Bedrock creds + a cluster");

  test("real goose responds to a prompt", async ({ chat }) => {
    await chat.open();
    await chat.send("Create a file hello.txt containing the word kubenix, then show its contents.");

    // Loose: a tool call runs and the final answer mentions the word.
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 120_000 });
    await expect(chat.assistantMessages().last()).toContainText(/kubenix/i, { timeout: 120_000 });
  });

  test("real goose tool calls survive a page refresh", async ({ chat, page }) => {
    // Real goose emits richer tool-call shapes than the fake agent, so drive a real
    // tool-using turn, reload, and assert the tool call replays from the persisted log.
    await chat.open();
    await chat.send("Run `echo kubenix-refresh-marker` in the shell and report the output.");
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 120_000 });
    await expect(chat.assistantMessages().last()).toContainText(/kubenix-refresh-marker/i, { timeout: 120_000 });

    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    // The tool call must rebuild from events.integrity replay, not the live stream.
    await expect(chat.toolCalls().first()).toBeVisible({ timeout: 60_000 });
  });
});
