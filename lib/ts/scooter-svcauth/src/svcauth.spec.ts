import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthError, CACHE_TTL_MS, TokenSource, Verifier, bearerToken, parseAllowlist, sandboxId, type ReviewFunc } from "./index.js";

const NS = "agent-sandbox";
const WEBHOOKS = `system:serviceaccount:${NS}:agent-webhooks`;
const BROKER = `system:serviceaccount:${NS}:agent-broker`;
const SANDBOX = `system:serviceaccount:${NS}:sandbox-abc123`;

function fakeReview(known: Record<string, string>): { review: ReviewFunc; calls: () => number } {
  let n = 0;
  return {
    review: async (token) => {
      n++;
      if (token === "boom") throw new Error("apiserver down");
      const username = known[token];
      return username ? { ok: true, username } : { ok: false };
    },
    calls: () => n,
  };
}

const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

describe("Verifier", () => {
  it("caches accepts and rejects for the TTL", async () => {
    const f = fakeReview({ good: BROKER });
    let t = 0;
    const v = new Verifier(f.review, () => t);
    await v.verify("good");
    await v.verify("good");
    await v.verify("bad");
    await v.verify("bad");
    expect(f.calls()).toBe(2);
    t = CACHE_TTL_MS;
    await v.verify("good");
    expect(f.calls()).toBe(3);
  });

  it("never caches review errors", async () => {
    const f = fakeReview({});
    const v = new Verifier(f.review);
    await expect(v.verify("boom")).rejects.toThrow();
    await expect(v.verify("boom")).rejects.toThrow();
    expect(f.calls()).toBe(2);
  });
});

describe("resolve", () => {
  const known = { wh: WEBHOOKS, br: BROKER, sb: SANDBOX, other: "system:serviceaccount:other:sandbox-x" };
  const policy = { services: parseAllowlist(BROKER), asserters: parseAllowlist(WEBHOOKS), sandboxNamespace: NS };
  const resolve = (headers: Record<string, string>) => new Verifier(fakeReview(known).review).resolve(headers, policy);
  const user = { "x-scooter-user": "chadac", "x-scooter-user-email": "c@example.com" };

  it("lets an asserter name a user", async () => {
    expect(await resolve(auth("wh", user))).toEqual({ kind: "service", serviceAccount: WEBHOOKS, user: "chadac", email: "c@example.com" });
  });

  it("ignores user headers from a plain service", async () => {
    expect(await resolve(auth("br", user))).toEqual({ kind: "service", serviceAccount: BROKER });
  });

  it("binds a sandbox to its id, only in the configured namespace", async () => {
    expect(await resolve(auth("sb", user))).toEqual({ kind: "sandbox", serviceAccount: SANDBOX, sandboxId: "abc123" });
    await expect(resolve(auth("other"))).rejects.toMatchObject({ code: "not-allowed", status: 403 });
  });

  it.each([
    [{}, "no-token", 401],
    [auth("nope"), "unauthenticated", 401],
    [auth("boom"), "review-failed", 503],
  ])("rejects %j as %s", async (headers, code, status) => {
    const err = await resolve(headers as Record<string, string>).catch((e: AuthError) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ code, status });
  });
});

describe("helpers", () => {
  it("parses bearer tokens case-insensitively", () => {
    expect(bearerToken({ authorization: "bearer  t " })).toBe("t");
    expect(bearerToken({ authorization: "Basic t" })).toBeUndefined();
  });

  it("matches sandbox SAs only within the namespace", () => {
    expect(sandboxId(SANDBOX, NS)).toBe("abc123");
    expect(sandboxId(SANDBOX, "")).toBeUndefined();
    expect(sandboxId(BROKER, NS)).toBeUndefined();
  });
});

describe("TokenSource", () => {
  it("re-reads a rotated token after the refresh interval", () => {
    const path = join(mkdtempSync(join(tmpdir(), "svcauth-")), "token");
    writeFileSync(path, "one\n");
    let t = 0;
    const s = new TokenSource(path, 1000, () => t);
    expect(s.headers("chadac")).toEqual({ authorization: "Bearer one", "x-scooter-user": "chadac" });
    writeFileSync(path, "two\n");
    expect(s.current()).toBe("one");
    t = 1000;
    expect(s.current()).toBe("two");
  });

  it("sends no token when none is mounted", () => {
    expect(new TokenSource("/nonexistent/token").headers()).toEqual({});
  });
});
