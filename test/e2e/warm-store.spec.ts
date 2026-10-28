/**
 * The warm overlay pool on the deployed platform: a new sandbox takes an idle pool volume,
 * suspend hands that volume back with its contents, resume takes it again, and a missing
 * controller never blocks a conversation from starting. test/cluster/warm-store.spec.ts covers the pieces;
 * this drives them through the agent-host and the controller as users trigger them.
 */
import type { APIRequestContext, Page } from "@playwright/test";

import { test, expect } from "./fixtures.js";
import { fullOnly } from "./target.js";

const HOOK = process.env.E2E_ROLLOUT_HOOK ?? "";
const POOL_CLASS = "warm-store-retain";

interface PvView {
  name: string;
  phase: string | null;
  pool: string | null;
  annotations: Record<string, string>;
  claim: string | null;
}

interface Overlay {
  sandbox: string;
  pvc: { phase: string | null; volume: string | null; storageClass: string | null } | null;
  pv: PvView | null;
}

const pool = async (request: APIRequestContext): Promise<PvView[]> =>
  (await request.get(`${HOOK}/pool`)).json();

const overlay = async (request: APIRequestContext, thread: string): Promise<Overlay> =>
  (await request.get(`${HOOK}/overlay/${thread}`)).json();

function threadOf(page: Page): string {
  const thread = new URL(page.url()).searchParams.get("thread");
  expect(thread, "the URL must name a conversation").toBeTruthy();
  return thread!;
}

/** The PV the conversation's overlay PVC bound to, once it has. */
async function boundVolume(request: APIRequestContext, thread: string): Promise<string> {
  let volume: string | null = null;
  await expect
    .poll(async () => {
      const o = await overlay(request, thread);
      volume = o.pvc?.phase === "Bound" ? o.pvc.volume : null;
      return volume;
    }, { message: "the overlay PVC must bind", timeout: 60_000 })
    .toBeTruthy();
  return volume!;
}

/** Wait for at least one idle pool volume; the first warm Job is a full sandbox boot. */
async function idlePool(request: APIRequestContext): Promise<string[]> {
  let names: string[] = [];
  await expect
    .poll(async () => (names = (await pool(request)).map((pv) => pv.name)).length, {
      message: "the controller must warm a pool volume",
      timeout: 480_000,
      intervals: [5_000],
    })
    .toBeGreaterThan(0);
  return names;
}

fullOnly("needs the warm-store controller and kubectl access to the pool")("warm overlay pool", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeEach(() => {
    test.skip(!HOOK, "no rollout hook configured for this run");
    test.setTimeout(720_000);
  });

  test("a new conversation starts on an idle pool volume", async ({ chat, page, request }) => {
    const idle = await idlePool(request);

    await chat.open();
    await chat.completeTurn("start me on a warm volume");
    const thread = threadOf(page);

    const volume = await boundVolume(request, thread);
    expect(idle, "the overlay must bind a volume that was idle in the pool").toContain(volume);
    expect((await overlay(request, thread)).pvc?.storageClass).toBe(POOL_CLASS);
  });

  test("suspend returns the volume to the pool, and resume takes it back with its contents", async ({
    chat,
    page,
    request,
    baseURL,
  }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    await chat.open();
    await chat.completeTurn("write something worth keeping");
    const thread = threadOf(page);
    const volume = await boundVolume(request, thread);

    const canary = `canary-${Date.now()}`;
    const wrote = await request.post(`${HOOK}/canary/${thread}`, { data: canary });
    expect(wrote.ok(), `the hook must write the canary: ${await wrote.text()}`).toBeTruthy();

    const suspended = await request.post(`${base}/conversations/${encodeURIComponent(thread)}/suspend`);
    expect(suspended.ok(), "suspend must succeed").toBeTruthy();

    // The marker check passes, the PVC goes, and the janitor recycles the PV as returned.
    await expect
      .poll(async () => {
        const pv = (await overlay(request, thread)).pv;
        return pv && `${pv.name} ${pv.phase} ${pv.pool}`;
      }, { message: "the suspended sandbox's volume must rejoin the pool", timeout: 240_000, intervals: [5_000] })
      .toBe(`${volume} Available returned`);

    // Sending into the suspended conversation revives it.
    const before = await chat.assistantMessages().count();
    await chat.send("back on the same volume?");
    await expect.poll(async () => chat.assistantMessages().count(), { timeout: 240_000 }).toBeGreaterThan(before);

    expect(await boundVolume(request, thread), "resume must reclaim its own volume").toBe(volume);
    const read = await request.get(`${HOOK}/canary/${thread}`);
    expect(await read.text(), "the volume's contents must survive the round trip").toBe(canary);
  });

  test("with the controller down, a new conversation still starts", async ({ chat, page, request }) => {
    const down = await request.post(`${HOOK}/warm-store/scale/0`, { timeout: 180_000 });
    expect(down.ok(), `the hook must stop the controller: ${await down.text()}`).toBeTruthy();
    let thread = "";
    try {
      await chat.open();
      await chat.completeTurn("no controller, no problem");
      thread = threadOf(page);
      // Native PV matching may bind a pool volume anyway.
      await boundVolume(request, thread);
    } finally {
      const up = await request.post(`${HOOK}/warm-store/scale/1`, { timeout: 240_000 });
      expect(up.ok(), `the hook must restart the controller: ${await up.text()}`).toBeTruthy();
    }

    // Back up, the controller adopts the unreserved volume so it can be recycled later.
    const { sandbox } = await overlay(request, thread);
    await expect
      .poll(async () => (await overlay(request, thread)).pv?.annotations["scooter.io/last-sandbox"], {
        message: "the janitor must adopt a volume provisioned without it",
        timeout: 120_000,
        intervals: [5_000],
      })
      .toBe(sandbox);
  });
});
