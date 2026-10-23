/**
 * The /contrib-api relay through the browser's own origin. On the full target that is the
 * UI's nginx, so these prove its /contrib-api/ location reaches the agent-host rather than
 * falling through to the SPA's index.html; on fast it is the vite proxy. No contrib with
 * `api = true` ships on either stack yet, so these cover the relay's refusals. The
 * round-trip to a real broker route is the personalization contrib's spec.
 */

import { request as pwRequest, type APIRequestContext } from "@playwright/test";
import { test, expect } from "./fixtures.js";

async function as(baseURL: string | undefined, headers: Record<string, string>): Promise<APIRequestContext> {
  return pwRequest.newContext({ baseURL: baseURL ?? "http://localhost:5173", extraHTTPHeaders: headers });
}

/** The agent-host answered, in JSON: not nginx's SPA fallback, which is 200 text/html. */
async function expectRelayJson(res: Awaited<ReturnType<APIRequestContext["get"]>>, status: number, error: RegExp) {
  expect(res.status(), await res.text()).toBe(status);
  expect(res.headers()["content-type"] ?? "").toContain("application/json");
  expect(((await res.json()) as { error?: string }).error ?? "").toMatch(error);
}

test.describe("/contrib-api relay", () => {
  test("an anonymous caller is refused, even naming a user itself", async ({ baseURL }) => {
    const anon = await as(baseURL, {});
    const forged = await as(baseURL, { "x-scooter-user": "alice" });
    try {
      await expectRelayJson(await anon.get("/contrib-api/echo/whoami"), 401, /sign in/);
      await expectRelayJson(await forged.get("/contrib-api/echo/whoami"), 401, /sign in/);
      await expectRelayJson(await forged.post("/contrib-api/echo/whoami", { data: {} }), 401, /sign in/);
    } finally {
      await anon.dispose();
      await forged.dispose();
    }
  });

  test("a signed-in user gets 404 for a contrib without the relay", async ({ baseURL }) => {
    const alice = await as(baseURL, { "x-auth-user": "alice" });
    try {
      await expectRelayJson(await alice.get("/contrib-api/no-such-contrib/whoami"), 404, /no settings API/);
      // Echo ships nowhere, so it has no relay row on either stack.
      await expectRelayJson(await alice.get("/contrib-api/echo/whoami"), 404, /no settings API/);
    } finally {
      await alice.dispose();
    }
  });
});
