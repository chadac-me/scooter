/**
 * The setup one-liner points at the BYOC controller. The controller path is per-owner
 * (`/byoc/ws/<session-id>`) and only the controller mints a session (`POST
 * /byoc/sessions`), so `mint` asks the controller for the owner's session and builds the
 * URL around it.
 */

import { describe, it, expect } from "vitest";

import { createRemoteAgentUi } from "../../src/acp/remoteAgentOneliner.js";

const SECRET = "test-secret";

/** A controller that mints `sessionId` for whoever asks. */
function controllerFetch(sessionId = "sess-abc", opts: { status?: number } = {}) {
  const calls: Array<{ url: string; method?: string; user?: string }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      user: (init?.headers as Record<string, string> | undefined)?.["x-auth-request-user"],
    });
    if (opts.status && opts.status >= 400) {
      return new Response(JSON.stringify({ error: "nope" }), { status: opts.status });
    }
    return new Response(JSON.stringify({ sessionId, token: "controller-token" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("setup one-liner via the BYOC controller", () => {
  it("mints a session for the owner and points the URL at /byoc/ws/<session-id>", async () => {
    const { impl } = controllerFetch("sess-abc");
    const ui = createRemoteAgentUi({
      joinSecret: SECRET,
      controllerUrl: "http://byoc-controller:8080",
      publicByocUrl: "https://byoc.example.com",
      fetchImpl: impl,
    });
    const out = await ui.mint("alice");
    expect(out.wsUrl).toBe("wss://byoc.example.com/byoc/ws/sess-abc");
    expect(out.dockerCommand).toContain("wss://byoc.example.com/byoc/ws/sess-abc");
  });

  it("mints PER OWNER — two users get different sessions, never a shared URL", async () => {
    // A per-owner session is what lets the controller route a prompt to the right container.
    let n = 0;
    const impl = (async () =>
      new Response(JSON.stringify({ sessionId: `sess-${++n}` }), { status: 200 })) as unknown as typeof fetch;
    const ui = createRemoteAgentUi({
      joinSecret: SECRET,
      controllerUrl: "http://c:8080",
      publicByocUrl: "https://byoc.example.com",
      fetchImpl: impl,
    });
    const a = await ui.mint("alice");
    const b = await ui.mint("bob");
    expect(a.wsUrl).not.toBe(b.wsUrl);
  });

  it("asks the controller AS the owner, so the session is owner-bound", async () => {
    const { impl, calls } = controllerFetch();
    const ui = createRemoteAgentUi({
      joinSecret: SECRET,
      controllerUrl: "http://byoc-controller:8080",
      publicByocUrl: "https://byoc.example.com",
      fetchImpl: impl,
    });
    await ui.mint("alice");
    expect(calls[0].url).toContain("/byoc/sessions");
    expect(calls[0].method).toBe("POST");
    // Without an identity the controller 401s, since a session must bind to an owner.
    expect(calls[0].user).toBe("alice");
  });

  it("still carries a join token — the container registers its device key with it once", async () => {
    const { impl } = controllerFetch();
    const ui = createRemoteAgentUi({
      joinSecret: SECRET,
      controllerUrl: "http://c:8080",
      publicByocUrl: "https://byoc.example.com",
      fetchImpl: impl,
    });
    const out = await ui.mint("alice");
    expect(out.token.split(".")).toHaveLength(3);
    expect(out.dockerCommand).toContain("--join");
  });

  it("http public URL yields ws://, https yields wss:// (no silent plaintext downgrade)", async () => {
    const { impl } = controllerFetch("s1");
    const mk = (publicByocUrl: string) =>
      createRemoteAgentUi({ joinSecret: SECRET, controllerUrl: "http://c:8080", publicByocUrl, fetchImpl: impl });
    expect((await mk("http://byoc.odin.lan").mint("a")).wsUrl).toBe("ws://byoc.odin.lan/byoc/ws/s1");
    expect((await mk("https://byoc.example.com").mint("a")).wsUrl).toBe("wss://byoc.example.com/byoc/ws/s1");
  });

  it("a controller that cannot mint FAILS LOUD — never a dead copy-paste URL", async () => {
    // A one-liner that cannot connect retries forever with nothing saying why.
    const { impl } = controllerFetch("x", { status: 503 });
    const ui = createRemoteAgentUi({
      joinSecret: SECRET,
      controllerUrl: "http://c:8080",
      publicByocUrl: "https://byoc.example.com",
      fetchImpl: impl,
    });
    await expect(ui.mint("alice")).rejects.toThrow(/could not mint|503/i);
  });

  it("keeps the volume + local login port, so an existing container's creds still work", async () => {
    const { impl } = controllerFetch();
    const ui = createRemoteAgentUi({
      joinSecret: SECRET,
      controllerUrl: "http://c:8080",
      publicByocUrl: "https://byoc.example.com",
      fetchImpl: impl,
    });
    const { dockerCommand } = await ui.mint("alice");
    expect(dockerCommand).toContain("-v scooter-claude:/root/.claude");
    expect(dockerCommand).toContain("127.0.0.1:34579:34579");
  });
});
