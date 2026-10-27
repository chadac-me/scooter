// ServiceAccount token auth; mirrors services/conversation-router/svcauth.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import type { IncomingHttpHeaders } from "node:http";

export const USER_HEADER = "x-scooter-user";
export const EMAIL_HEADER = "x-scooter-user-email";

/** Resolves a bearer token to its username, or `ok: false` if rejected. */
export type ReviewFunc = (token: string) => Promise<{ ok: boolean; username?: string }>;

export const REVIEW_TIMEOUT_MS = 5_000;
export const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 4096;

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** In-cluster TokenReview pinned to comma-separated audiences, or the default. */
export function inClusterReviewer(audience: string, saDir = SA_DIR): ReviewFunc {
  return async (token) => {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
    if (!host) throw new Error("tokenreview: not running in a cluster");
    const audiences = audience.split(",").map((a) => a.trim()).filter(Boolean);
    const body = JSON.stringify({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      spec: { token, ...(audiences.length ? { audiences } : {}) },
    });
    const own = readFileSync(`${saDir}/token`, "utf8").trim();
    const ca = readFileSync(`${saDir}/ca.crt`);
    const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        {
          host: host.includes(":") ? `[${host}]` : host,
          port,
          path: "/apis/authentication.k8s.io/v1/tokenreviews",
          method: "POST",
          ca,
          timeout: REVIEW_TIMEOUT_MS,
          headers: { authorization: `Bearer ${own}`, "content-type": "application/json" },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("tokenreview timed out")));
      req.on("error", reject);
      req.end(body);
    });
    // 403 means missing RBAC, not a spoof.
    if (status >= 300) throw new Error(`tokenreview returned ${status}: ${text.trim()}`);
    const out = JSON.parse(text) as { status?: { authenticated?: boolean; user?: { username?: string } } };
    return { ok: out.status?.authenticated === true, username: out.status?.user?.username };
  };
}

/** Caches verdicts, never errors, so blips don't pin rejections. */
export class Verifier {
  private cache = new Map<string, { username?: string; ok: boolean; until: number }>();

  constructor(
    private readonly review: ReviewFunc,
    public now: () => number = Date.now,
  ) {}

  async verify(token: string): Promise<{ ok: boolean; username?: string }> {
    const key = createHash("sha256").update(token).digest("hex");
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now < hit.until) return { ok: hit.ok, username: hit.username };
    const v = await this.review(token);
    if (this.cache.size >= CACHE_MAX) {
      for (const [k, c] of this.cache) if (now >= c.until) this.cache.delete(k);
      if (this.cache.size >= CACHE_MAX) this.cache.clear();
    }
    this.cache.set(key, { ok: v.ok, username: v.username, until: now + CACHE_TTL_MS });
    return v;
  }

  /** Ignores identity headers from non-asserters; forwarders must strip. */
  async resolve(headers: IncomingHttpHeaders, policy: Policy): Promise<Principal> {
    const token = bearerToken(headers);
    if (!token) throw new AuthError("no-token", "bearer token required");
    let v: { ok: boolean; username?: string };
    try {
      v = await this.verify(token);
    } catch (e) {
      throw new AuthError("review-failed", `token review: ${(e as Error)?.message ?? e}`);
    }
    if (!v.ok || !v.username) throw new AuthError("unauthenticated", "token not authenticated");
    const sa = v.username;
    if (policy.asserters?.has(sa)) {
      return { kind: "service", serviceAccount: sa, user: header(headers, USER_HEADER), email: header(headers, EMAIL_HEADER) };
    }
    if (policy.services?.has(sa)) return { kind: "service", serviceAccount: sa };
    const id = sandboxId(sa, policy.sandboxNamespace ?? "");
    if (id) return { kind: "sandbox", serviceAccount: sa, sandboxId: id };
    throw new AuthError("not-allowed", `caller not allowed: ${sa}`, sa);
  }
}

export type Kind = "service" | "sandbox";

/** user/email are set only when an asserter vouched. */
export interface Principal {
  kind: Kind;
  serviceAccount: string;
  sandboxId?: string;
  user?: string;
  email?: string;
}

export interface Policy {
  services?: ReadonlySet<string>;
  /** May set X-Scooter-User; admitted as services too. */
  asserters?: ReadonlySet<string>;
  /** Admits `sandbox-<id>` SAs here; empty admits none. */
  sandboxNamespace?: string;
}

export type AuthErrorCode = "no-token" | "unauthenticated" | "not-allowed" | "review-failed";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly serviceAccount?: string,
  ) {
    super(message);
    this.name = "AuthError";
  }

  /** 401, 403 or 503. */
  get status(): number {
    if (this.code === "not-allowed") return 403;
    if (this.code === "review-failed") return 503;
    return 401;
  }
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const h = headers[name];
  const v = (Array.isArray(h) ? h[0] : h)?.trim();
  return v || undefined;
}

/** The `Authorization: Bearer` value, or undefined. */
export function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const v = header(headers, "authorization");
  if (!v || !/^bearer /i.test(v)) return undefined;
  return v.slice(7).trim() || undefined;
}

const SANDBOX_SA = /^sandbox-([a-z0-9][a-z0-9-]*)$/;

/** Extracts `<id>` from `sandbox-<id>`, only within namespace. */
export function sandboxId(username: string, namespace: string): string | undefined {
  if (!namespace) return undefined;
  const prefix = `system:serviceaccount:${namespace}:`;
  if (!username.startsWith(prefix)) return undefined;
  return SANDBOX_SA.exec(username.slice(prefix.length))?.[1];
}

export function parseAllowlist(csv: string | undefined): Set<string> {
  return new Set((csv ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

/** Re-reads the token file; the kubelet rotates it. */
export class TokenSource {
  private token = "";
  private read = 0;

  constructor(
    readonly path: string,
    readonly refreshMs = 60_000,
    public now: () => number = Date.now,
  ) {}

  /** "" when no token is mounted. */
  current(): string {
    const now = this.now();
    if (this.token && now - this.read < this.refreshMs) return this.token;
    try {
      this.token = readFileSync(this.path, "utf8").trim();
    } catch (e) {
      if ((e as { code?: string })?.code === "ENOENT") return "";
      throw new Error(`read service token ${this.path}: ${(e as Error)?.message ?? e}`, { cause: e });
    }
    this.read = now;
    return this.token;
  }

  /** Bearer token plus, if set, user headers. */
  headers(user?: string, email?: string): Record<string, string> {
    const out: Record<string, string> = {};
    const token = this.current();
    if (token) out["authorization"] = `Bearer ${token}`;
    if (user) {
      out[USER_HEADER] = user;
      if (email) out[EMAIL_HEADER] = email;
    }
    return out;
  }
}
