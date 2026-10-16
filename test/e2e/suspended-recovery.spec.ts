/**
 * Tier 3 E2E for recovered conversations: the suspended → revived user journey. Each test
 * drives the real lifecycle through POST /conversations/:id/suspend (which drops the bridge
 * and pod exactly like the idle sweep or a rollout) and then exercises the UI: history and
 * the integrity stream, sending into a suspended conversation, and approvals after a revive.
 */

import { test, expect } from "./fixtures.js";

const panel = {
  root: '[data-testid="interrupt-panel"]',
  option: '[data-testid="interrupt-option"]',
  approvalsTab: '[data-testid="right-panel-tab-approvals"]',
};

/** The conversation the UI is actually showing, read from its own persisted selection
 *  rather than `/conversations[0]`, which another spec's leftover can occupy. */
async function currentConversationId(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  base: string,
): Promise<string> {
  // The server's id, not `currentId`, which for a conversation created on its first send is
  // a placeholder the server never issued.
  const fromUi = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem("kubenix-agent.sessions.v1");
      if (!raw) return null;
      const st = JSON.parse(raw) as {
        currentId?: string;
        sessions?: Array<{ id: string; serverId?: string }>;
      };
      const cur = st.sessions?.find((s) => s.id === st.currentId);
      return cur?.serverId ?? null;
    } catch {
      return null;
    }
  });
  if (fromUi) return fromUi;
  const list = await (await request.get(`${base}/conversations`)).json();
  const id: string = list[0].id;
  expect(id, "a conversation must exist to suspend").toBeTruthy();
  return id;
}

/** Suspend for real — drops the in-memory bridge and the sandbox pod. */
async function suspend(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  id: string,
) {
  const res = await request.post(`${base}/conversations/${encodeURIComponent(id)}/suspend`);
  expect(res.ok(), "suspend must succeed").toBeTruthy();
}

/** POST the approval exactly like a contrib's broker half does (aws _notify_host). */
async function requestAws(
  request: import("@playwright/test").APIRequestContext,
  base: string,
  conversationId: string,
  requestId: string,
) {
  return request.post(`${base}/conversations/${encodeURIComponent(conversationId)}/approvals/aws`, {
    headers: { "Content-Type": "application/json" },
    // An id plus the prose the contrib rendered; the platform relays an opaque message.
    data: {
      request_id: requestId,
      message:
        "Scooter is requesting AWS access to dev (risk: low).\n" +
        "s3:GetObject on the state bucket\n" +
        "Reason: read terraform state",
    },
  });
}

// Every test here funds two sandbox boots on the full target (the opening turn and the
// revive), so the suite default is too short.
const TWO_BOOT_BUDGET = 240_000;

test.describe("recovered conversation — history + integrity stream", () => {
  test.setTimeout(TWO_BOOT_BUDGET);
  test("the integrity stream serves a SUSPENDED conversation (200, full history, no silent 404 loop)", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // A 404 here is invisible in the UI: the client backoff-polls with no banner and no error.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("remember me across the nap");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    // events.integrity is a long-lived SSE stream, so read it incrementally and stop at `synced`.
    const { body, status } = await page.evaluate(
      async ({ url }) => {
        const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
        if (!res.ok || !res.body) return { status: res.status, body: "" };
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          if (acc.includes('"kind":"synced"')) break; // replay complete
        }
        await reader.cancel().catch(() => {});
        return { status: res.status, body: acc };
      },
      { url: `${base}/conversations/${encodeURIComponent(id)}/events.integrity` },
    );

    expect(status, "a suspended conversation must still be readable, not 404").toBe(200);
    expect(body, "history must replay off the durable log with no live pod").toContain(
      "remember me across the nap",
    );
    expect(body).toContain('"kind":"synced"');
  });

  test("opening a SUSPENDED conversation renders its history (not an empty thread)", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("history before suspend");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    // Deep-link with ?thread=<id> rather than a bare reload, since a starred leftover
    // conversation can win the restored selection.
    await page.goto(`/?thread=${encodeURIComponent(id)}`);
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await expect(
      chat.userMessages().filter({ hasText: /history before suspend/i }),
      "a suspended conversation must render its history, not an empty thread",
    ).toHaveCount(1, { timeout: 30_000 });
  });
});

test.describe("recovered conversation — sending a message revives it", () => {
  test.setTimeout(TWO_BOOT_BUDGET);
  test("a message sent to a SUSPENDED conversation is delivered and answered", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // The send must auto-revive and produce a reply; a failed revive shows nothing in the UI
    // because the RUN_ERROR rides the POST's own SSE body.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("first turn");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    // Assert on this message's own text rather than sendTurn's count, because a suspend
    // rebuilds the thread view and can reset the count.
    await chat.send("wake up and answer me");

    // The send must first revive the conversation, which on the full target provisions a
    // fresh sandbox pod.
    await expect(
      chat.userMessages().filter({ hasText: /wake up and answer me/i }),
      "the message sent to a suspended conversation must appear in the thread",
    ).toHaveCount(1, { timeout: 90_000 });

    // It must actually run (a second assistant turn must exist), anchored on the data-slot
    // the component emits because the assistant markup carries no .aui-assistant-message-content class.
    await expect
      .poll(async () => page.locator('[data-slot="aui_assistant-message-root"]').count(), {
        timeout: 90_000,
      })
      .toBeGreaterThanOrEqual(2);
  });

  test("the message sent to a suspended conversation does NOT get stuck as a queued message", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // The UI shows an optimistic queued row the instant you send and clears it only once the
    // server confirms the text, so a revive that never lands pins the row forever.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("before the nap");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    await chat.send("this must not get stuck"); // see the sendTurn note above

    // On the full target the row clears only after the revive's fresh sandbox boot.
    await expect(
      chat.queuedMessages(),
      "the queue must DRAIN after the revive — a pinned row is the reported bug",
    ).toHaveCount(0, { timeout: 60_000 });
  });

  test("a conversation suspended MID-RUN with a queued message recovers without a phantom queue", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // Items sitting in the bridge's in-memory queue when the bridge is torn down must survive the suspend.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    // The suspend must land while the run is still in flight, and on the full target the
    // exec waits for a ready pod before the sleep starts.
    await chat.startLongRun(60);
    await chat.sendWhileRunning("queued before the suspend");
    await expect(chat.queuedMessages()).toHaveCount(1, { timeout: 15_000 });

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    // Revive by sending and assert on this message's echo, since /dummy agent/i already
    // matches the earlier turn's reply.
    await chat.send("after the suspend");
    await expect(
      page.getByText(/after the suspend/i).first(),
      "the post-suspend send must actually run on the revived conversation",
    ).toBeVisible({ timeout: 45_000 });

    // suspend() drains the in-memory queue onto the persisted meta and revive() re-enqueues
    // it, so the pre-suspend item must run on the revived conversation.
    const queuedItem = page.getByText(/queued before the suspend/i).first();
    // A pod restart mid-test rebuilds the queue through restart recovery instead, so skip
    // only when the restart marker is actually in the thread.
    const restarted = async () =>
      (await page.getByText(/this conversation was interrupted by a restart/i).count()) > 0;
    let landed = false;
    for (let i = 0; i < 90 && !landed; i++) {
      if (await queuedItem.isVisible().catch(() => false)) { landed = true; break; }
      if (await restarted()) break;
      await page.waitForTimeout(1_000);
    }
    if (!landed && (await restarted())) {
      test.skip(true, "the conversation's pod restarted mid-test: the queue was rebuilt by restart recovery, not by the suspend/revive path this asserts on");
    }
    await expect(
      queuedItem,
      "a message queued when the conversation was suspended must NOT be silently lost",
    ).toBeVisible({ timeout: 15_000 });

    // Only now assert the queue is empty: while the re-enqueued message is draining the
    // count is transiently 1, and a phantom row survives any budget.
    await expect(
      chat.queuedMessages(),
      "no phantom queued row may survive the suspend/revive",
    ).toHaveCount(0, { timeout: 90_000 });
  });
});

test.describe("recovered conversation — approvals after a revive", () => {
  test.setTimeout(TWO_BOOT_BUDGET);
  test("a NEW AWS approval raised AFTER a revive appears in the tab", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // A brand-new approval on an already-revived conversation, whose bridge is a different
    // instance than the one the tab first attached to.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("terraform work");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);

    // Revive via a normal send, then raise a fresh approval.
    await chat.send("continue the plan"); // see the sendTurn note above

    const res = await requestAws(request, base, id, `awsreq-post-revive-${Date.now()}`);
    expect(res.status(), "the approval must be accepted on the revived conversation").toBe(202);

    // The approval is accepted (202 above); this waits on it reaching the browser through a
    // rebuilt bridge, which on the full target sits behind the revive's sandbox wait.
    await expect(
      page.locator(panel.root),
      "an approval raised after a revive must appear — the reported invisible-approval bug",
    ).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(panel.option).filter({ hasText: /approve/i })).toHaveCount(1);
  });

  test("an approval raised after a revive survives a reload (it is durable, not bridge-only)", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // An interrupt that lives only in the new bridge's memory is invisible to a tab that
    // connects later, so it must be in the durable log.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("infra task");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    await suspend(request, base, id);
    // Revive by sending and wait for that turn to finish before reloading, polling the
    // run-status bar rather than counts or text.
    await chat.send("resume the infra task");
    // On the full target this idle-wait spans the revive's fresh sandbox boot.
    await chat.waitForIdle(90_000);

    const raised = await requestAws(request, base, id, `awsreq-durable-${Date.now()}`);
    expect(
      raised.status(),
      `the approval must be accepted on the revived conversation (got ${raised.status()}: ${await raised.text().catch(() => "")})`,
    ).toBe(202);
    // The same post-revive delivery hop as the test above.
    await expect(
      page.locator(panel.root),
      "the approval must appear on the revived conversation before we test reload durability",
    ).toBeVisible({ timeout: 90_000 });

    // Plain reload: the conversation is already selected, so there is nothing to deep-link to.
    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 30_000 });
    // After a reload the Approvals tab is not auto-focused (RightPanel only steals focus
    // when the pending count rises), so select it explicitly.
    await page.locator(panel.approvalsTab).click();
    await expect(
      page.locator(panel.root),
      "the post-revive approval must replay from the log after a reload",
    ).toBeVisible({ timeout: 30_000 });
  });

  test("answering an approval on a conversation suspended AFTER it was raised resolves promptly", async ({
    chat,
    page,
    baseURL,
    request,
  }) => {
    // The approval is raised, the conversation goes to sleep, and the user answers from a
    // tab that was open the whole time; the answer must revive and route, never hang.
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.send("apply the terraform");
    await chat.waitForReply(/dummy agent/i);

    const id = await currentConversationId(page, request, base);
    const reqId = `awsreq-answer-${Date.now()}`;
    expect((await requestAws(request, base, id, reqId)).status()).toBe(202);
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });

    await suspend(request, base, id);

    // Answer via the same POST /agui { resume } the InterruptPanel issues; in this stack the
    // Approve control is gated on an admin approver, so a click would assert authorization,
    // not recovery.
    const started = Date.now();
    const resume = await request.post(`${base}/agui`, {
      headers: { "Content-Type": "application/json" },
      timeout: 20_000, // a dormant-run hang only resolves at this timeout
      data: {
        threadId: id,
        resume: [{ interruptId: reqId, status: "resolved", payload: { optionId: "approve" } }],
      },
    });
    const elapsed = Date.now() - started;

    expect(resume.ok(), "the resume POST must return, not hang").toBeTruthy();
    const body = await resume.text();
    expect(body.length, "the resume stream must carry frames, not 0 bytes").toBeGreaterThan(0);
    // The decisive assertion is that it returned promptly: the revive-before-answer path
    // does not wait for a sandbox pod, so a healthy answer lands far under the 20s hang ceiling.
    expect(elapsed, `resume took ${elapsed}ms — a hang would run to the ~20s timeout`).toBeLessThan(12_000);
  });
});
