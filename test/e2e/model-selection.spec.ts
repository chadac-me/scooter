/**
 * Tier 3 E2E — per-conversation model selection through the real UI.
 *
 * BUILD FIRST. The fake stack runs services/agent-host/dist/index.js (a PREBUILT
 * artifact, fakeBackend.mjs:168), not the TypeScript source. An agent-host change
 * needs `npm -w services/agent-host run build` before these tests see it —
 * otherwise the stack silently serves whatever dist was last compiled. Three days
 * of stale dist is what made these very tests look like product bugs.
 *
 * The fake stack is configured (playwright.config) with GOOSE_MODEL=model-default
 * and AGENT_AVAILABLE_MODELS=model-default,model-fast,model-smart. The fake agent
 * echoes its launch GOOSE_MODEL via the "~model" directive — so picking a model in
 * the UI and sending "~model" proves the choice reached the agent PROCESS
 * end-to-end (UI picker -> X-Agent-Model header -> /agui -> promptByThread(model)
 * -> bridge rebuilt with GOOSE_MODEL).
 */

import { test, expect } from "./fixtures.js";

test.describe("model selection", () => {
  test("the picker offers the configured models with the default marked", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();
    // FOUR, not three: the catalog tags providers, so model-default (offered by
    // both) appears under each group. This asserted 3 from the untagged era.
    await expect(picker.locator("option")).toHaveCount(4);
    // model-default is defaultFor BOTH providers, so it is labelled in both groups.
    await expect(picker.locator("option", { hasText: "(default)" })).toHaveCount(2);
  });

  test("default model is used when nothing is picked", async ({ chat }) => {
    await chat.open();
    await chat.send("~model");
    await expect(chat.assistantMessages().last()).toContainText(/model=model-default/, {
      timeout: 45_000,
    });
  });

  test("picking a non-default model sends it to the agent", async ({ chat, page }) => {
    await chat.open();
    await page.getByTestId("model-picker").selectOption("model-smart");
    await chat.send("~model");

    // The fake agent reports the GOOSE_MODEL it was launched with -> proves the
    // picked model reached the agent process.
    await expect(chat.assistantMessages().last()).toContainText(/model=model-smart/, {
      timeout: 45_000,
    });
  });

  // Was QUARANTINED (fixme) — a SERVER-SIDE race: a mid-conversation switch does
  // bridge.stop() -> close() -> revive() (relaunch goose with the new GOOSE_MODEL).
  // close() fire-and-forget child.kill(), so under slow timing the OLD
  // goose could still be alive (sharing the per-conversation cwd) when the new one
  // spawned, and the reply reflected the old model. FIXED: close() now awaits the
  // child's actual exit (SIGTERM -> wait -> SIGKILL after a grace), so the old
  // process is gone before the new one starts. Un-fixme'd.
  test("switching the model mid-conversation takes effect on the next prompt", async ({ chat, page }) => {
    await chat.open();
    await page.getByTestId("model-picker").selectOption("model-fast");
    await chat.send("~model");
    await expect(chat.assistantMessages().last()).toContainText(/model=model-fast/, { timeout: 45_000 });

    // Switch mid-conversation -> the next prompt rebuilds goose with the new model.
    await page.getByTestId("model-picker").selectOption("model-smart");
    await chat.send("~model");
    await expect(chat.assistantMessages().last()).toContainText(/model=model-smart/, { timeout: 45_000 });
  });
});

// --- PROVIDER GROUPING (the gap that let two live bugs through) ----------------
//
// The existing tests above assert the model ID reaches the agent. That was never
// broken. What WAS broken, and had no coverage at any tier:
//
//   1. every <option value> was a bare model id, so "claude-code > X" and
//      "byoc > X" were indistinguishable and picking a provider did nothing
//   2. "(default)" was computed against ONE global default, so a model that is
//      the default for one provider was labelled under every group
//
// Both only appear when the catalog TAGS models with providers — the grouped
// branch. The fake stack was untagged, so the branch never rendered in e2e.

test.describe("model selection — provider grouping", () => {
  test("REPRO 1: each option's value carries its PROVIDER, not just the model id", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();

    // The grouped branch must actually render, or this test proves nothing.
    // NOTE: assert on the DOM, not the a11y tree — getByRole/aria flattens optgroup.
    await expect(picker.locator("optgroup")).toHaveCount(2);

    const values = await picker.locator("option").evaluateAll((os) =>
      os.map((o) => (o as HTMLOptionElement).value),
    );
    // model-default is offered by BOTH providers, so it appears twice. The two
    // options must be DISTINGUISHABLE: a bare model id made them identical, which
    // is why selecting the cloud group could never move a run off byoc.
    const forDefault = values.filter((v) => v.endsWith("model-default"));
    expect(forDefault.length).toBe(2);
    expect(new Set(forDefault).size).toBe(2);
    expect(values).toContain("byoc:model-default");
    expect(values).toContain("claude-code:model-default");
  });

  test("REPRO 2: (default) is marked per PROVIDER, not against one global default", async ({ chat, page }) => {
    await chat.open();
    const picker = page.getByTestId("model-picker");
    await expect(picker).toBeVisible();

    // model-smart is byoc-only and NOT a default anywhere, so it must never carry
    // the marker. model-default is defaultFor BOTH, so it carries it twice — that
    // is correct, and the test pins it so a future change cannot silently drop it.
    const labelled = await picker.locator("option").evaluateAll((os) =>
      os.filter((o) => o.textContent?.includes("(default)")).map((o) => o.textContent ?? ""),
    );
    expect(labelled.length).toBe(2);
    for (const t of labelled) expect(t).toContain("model-default");
  });

  test("REPRO 3: picking a provider-only model routes to THAT provider", async ({ chat, page }) => {
    await chat.open();
    // model-fast is claude-code ONLY. Picking it must reach the agent — the model
    // half of routing, which the provider-scoped value must not break.
    await page.getByTestId("model-picker").selectOption("claude-code:model-fast");
    await chat.send("~model");
    await expect(chat.assistantMessages().last()).toContainText(/model=model-fast/, {
      timeout: 45_000,
    });
  });
});
