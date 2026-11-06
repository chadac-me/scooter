/**
 * contrib/docker on a real sandbox: the first `docker` call socket-activates the nested
 * dockerd, which realizes its nix-stubs shims and pulls an image through the forge shim.
 */
import { test, expect } from "./fixtures.js";
import { fullOnly } from "./target.js";

const HOOK = process.env.E2E_ROLLOUT_HOOK ?? "";

fullOnly("needs a real sandbox pod and kubectl exec into it")("docker in the sandbox", () => {
  test.beforeEach(() => {
    test.skip(!HOOK, "no rollout hook configured for this run");
    test.setTimeout(300_000);
  });

  test("docker run works from a cold store", async ({ chat, page, request }) => {
    await chat.open();
    await chat.completeTurn("start a sandbox for docker");
    const thread = new URL(page.url()).searchParams.get("thread");
    expect(thread, "the URL must name a conversation").toBeTruthy();

    const res = await request.post(`${HOOK}/docker/${thread}`, { timeout: 200_000 });
    const out = await res.text();
    expect(res.ok(), `docker run must succeed: ${out}`).toBeTruthy();
    expect(out).toContain("docker-ok");
  });
});
