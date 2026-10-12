/**
 * The conversation the client thinks it is in must be the conversation the server actually
 * has. Every other suite asserts internal consistency (UI surfaces agreeing with each other,
 * or a second tab agreeing with the first), which passes when a client-minted phantom id is
 * copied around consistently; these tests read what the client wrote and ask the server
 * about it.
 */
import { test, expect } from "./fixtures.js";

/** The `?thread=` id the app itself put in the address bar. */
function threadIdFromUrl(url: string): string | null {
  return new URL(url).searchParams.get("thread");
}

/**
 * Every conversation id the server admits to, asked through the browser's own origin, since
 * on a cluster the API is served by the UI's nginx.
 */
async function serverIds(
  request: { get: (u: string) => Promise<{ json: () => Promise<unknown> }> },
  base: string,
) {
  const list = (await (await request.get(`${base.replace(/\/$/, "")}/conversations`)).json()) as Array<{
    id: string;
  }>;
  return list.map((c) => c.id);
}

/**
 * Assert the server admits to `id`, re-reading the list on the full target because the
 * router's aggregate can be transiently partial.
 */
async function expectServerHas(
  request: { get: (u: string) => Promise<{ json: () => Promise<unknown> }> },
  base: string,
  id: string,
  why: string,
) {
  let ids: string[] = [];
  // Single read on fast, where a miss is real.
  const attempts = process.env.E2E_TARGET === "full" ? 10 : 1;
  for (let i = 0; i < attempts; i++) {
    ids = await serverIds(request, base);
    if (ids.includes(id)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect(ids, why).toContain(id);
}

test.describe("client/server conversation identity", () => {
  // The new-conversation test funds two sequential sandbox boots at cluster pace;
  // completeTurn's own poll has its own default, which test.setTimeout does not extend.
  test.setTimeout(240_000);

  test("the id in the URL is one the SERVER issued", async ({ chat, page, request, baseURL }) => {
    const base = baseURL!;
    await chat.open();
    await chat.completeTurn("identity check");

    const urlId = threadIdFromUrl(page.url());
    expect(urlId, "the app must put a thread id in the URL").toBeTruthy();

    // A client-minted id passes every other test in the suite and fails here.
    await expectServerHas(request, base, urlId!, `URL id ${urlId} must exist server-side`);
  });

  test("the URL id survives a reload — the conversation does not vanish", async ({ chat, page, request, baseURL }) => {
    const base = baseURL!;
    await chat.open();
    await chat.completeTurn("reload check");
    const before = threadIdFromUrl(page.url());

    await page.reload();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    // A refresh resolves to nothing when the URL names something the server 404s.
    expect(threadIdFromUrl(page.url()), "the id must not change across a reload").toBe(before);
    await expectServerHas(request, base, before!, `URL id ${before} must exist server-side`);
    await expect(chat.userMessages().first()).toBeVisible({ timeout: 20_000 });
  });

  test("a NEW conversation gets a server id before it appears in the URL", async ({ chat, page, request, baseURL }) => {
    const base = baseURL!;
    await chat.open();
    await chat.completeTurn("first conversation", 100_000);
    const first = threadIdFromUrl(page.url());

    // The exact flow that broke: click New conversation, then send.
    await page.locator('[data-testid="new-session"]').click();
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await chat.completeTurn("second conversation", 100_000);

    const second = threadIdFromUrl(page.url());
    expect(second, "a new conversation must get its own id").not.toBe(first);
    await expectServerHas(request, base, second!, `new-conversation URL id ${second} must be real`);
  });

  test("the streamed conversation is the SAME one the URL names", async ({ chat, page, request, baseURL }) => {
    const base = baseURL!;
    const streamed: string[] = [];
    // Catch the divergence directly: the stream on the real id while the URL holds a phantom.
    page.on("request", (r) => {
      const m = /\/conversations\/([0-9a-f-]{36})\/events\.integrity/.exec(r.url());
      if (m) streamed.push(m[1]!);
    });

    await chat.open();
    await chat.completeTurn("stream identity check");

    const urlId = threadIdFromUrl(page.url());
    expect(streamed.length, "the UI must have opened an integrity stream").toBeGreaterThan(0);
    expect(new Set(streamed), "every stream must target the URL's conversation").toEqual(new Set([urlId]));
    await expectServerHas(request, base, urlId!, `URL id ${urlId} must exist server-side`);
  });
});
