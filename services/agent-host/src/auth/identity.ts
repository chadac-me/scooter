/**
 * User identity from a trusted ingress, provider-agnostic: the agent-host does no
 * login itself but trusts the ingress to authenticate the user and hand over the
 * identity, read by a pluggable `IdentityResolver` (`header` reads
 * x-auth-user/x-auth-email; `alb-oidc` reads AWS ALB's OIDC headers). A missing
 * identity is the single `anonymous` user. The ingress is the trust boundary, so the
 * agent-host must not be exposed without one that sets and strips identity headers;
 * identity is used for conversation ownership (a view filter), not access control.
 */

import type { IncomingMessage } from "node:http";

export interface UserContext {
  /** Stable user id: the header value, the OIDC `sub`, or "anonymous". */
  id: string;
  /** Email, when the ingress provides one. */
  email?: string;
  /** Display name, when available. */
  name?: string;
  /** True when no identity was present. */
  anonymous: boolean;
}

export const ANONYMOUS_USER = "anonymous";

/** Resolve identity from one request synchronously; DB enrichment and signature verification are layered on top via async wrappers (identityStore.ts, albVerify.ts). */
export interface IdentityResolver {
  resolve(req: IncomingMessage): UserContext;
}

/** A resolver that may be async, satisfied by both the sync resolvers and the async wrappers so they compose. */
export interface AsyncIdentityResolver {
  resolve(req: IncomingMessage): UserContext | Promise<UserContext>;
}

// --- header helpers --------------------------------------------------------

/** A single header value (node lowercases header names; values may be string[]). */
function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s : undefined;
}

// --- header resolver (default; Traefik / basic / forward-auth / oauth2-proxy) --

export interface HeaderIdentityConfig {
  /** Header carrying the user id (default "x-auth-user"). */
  userHeader: string;
  /** Header carrying the user email (default "x-auth-email"). */
  emailHeader: string;
}

export function createHeaderResolver(config: HeaderIdentityConfig): IdentityResolver {
  return {
    resolve(req) {
      const id = header(req, config.userHeader);
      if (!id) return { id: ANONYMOUS_USER, anonymous: true };
      return { id, email: header(req, config.emailHeader), anonymous: false };
    },
  };
}

// --- ALB OIDC resolver -----------------------------------------------------

/** Decode a JWT's payload without verifying the signature (the ALB is the trust boundary), returning {} on any parse failure. */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(payload, "base64").toString("utf8");
    const claims = JSON.parse(json);
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface AlbOidcConfig {
  /** Header carrying the OIDC subject (default "x-amzn-oidc-identity"). */
  identityHeader: string;
  /** Header carrying the signed OIDC claims JWT (default "x-amzn-oidc-data"). */
  dataHeader: string;
}

/** AWS ALB with OIDC auth: the `sub` in x-amzn-oidc-identity is the stable id, and email/name come from the claims of the x-amzn-oidc-data JWT. */
export function createAlbOidcResolver(config: AlbOidcConfig): IdentityResolver {
  return {
    resolve(req) {
      const sub = header(req, config.identityHeader);
      if (!sub) return { id: ANONYMOUS_USER, anonymous: true };
      const data = header(req, config.dataHeader);
      const claims = data ? decodeJwtClaims(data) : {};
      const email = typeof claims.email === "string" ? claims.email : undefined;
      const name = typeof claims.name === "string" ? claims.name : undefined;
      return { id: sub, email, name, anonymous: false };
    },
  };
}

// --- selection from env ----------------------------------------------------

export type AuthMode = "header" | "alb-oidc";

/** Build the configured resolver: AUTH_MODE selects the provider (default "header"), with header names overridable. */
export function resolverFromEnv(): IdentityResolver {
  const mode = (process.env.AUTH_MODE || "header").toLowerCase() as AuthMode;
  if (mode === "alb-oidc") {
    return createAlbOidcResolver({
      identityHeader: process.env.AUTH_ALB_IDENTITY_HEADER || "x-amzn-oidc-identity",
      dataHeader: process.env.AUTH_ALB_DATA_HEADER || "x-amzn-oidc-data",
    });
  }
  return createHeaderResolver({
    userHeader: process.env.AUTH_USER_HEADER || "x-auth-user",
    emailHeader: process.env.AUTH_EMAIL_HEADER || "x-auth-email",
  });
}

// --- handoff into a sandbox (web-service proxy) ------------------------------

/** Set by the proxy so an in-pod service knows who is calling. */
export const HANDOFF_USER_HEADER = "x-scooter-user";
/** The caller's email, when the ingress supplied one. */
export const HANDOFF_EMAIL_HEADER = "x-scooter-user-email";

/** Inbound headers dropped before forwarding: ingress identity (incl. a live OIDC token) and forged handoffs. */
export function inboundIdentityHeaders(): string[] {
  const cfg = identityConfigFromEnv();
  return [
    cfg.userHeader,
    cfg.emailHeader,
    (process.env.AUTH_ALB_IDENTITY_HEADER || "x-amzn-oidc-identity").toLowerCase(),
    (process.env.AUTH_ALB_DATA_HEADER || "x-amzn-oidc-data").toLowerCase(),
    "x-amzn-oidc-accesstoken",
    HANDOFF_USER_HEADER,
    HANDOFF_EMAIL_HEADER,
  ];
}

/** `headers` with inbound identity stripped and `user` stamped on; anonymous stamps nothing. */
export function withHandoffIdentity<T extends Record<string, unknown>>(
  headers: T,
  user: UserContext | undefined,
): T {
  const out = { ...headers } as Record<string, unknown>;
  for (const name of inboundIdentityHeaders()) delete out[name];
  if (user && !user.anonymous && user.id) {
    out[HANDOFF_USER_HEADER] = user.id;
    if (user.email) out[HANDOFF_EMAIL_HEADER] = user.email;
  }
  return out as T;
}

// --- synchronous header parse -----------------------------------------------------------
export type IdentityConfig = HeaderIdentityConfig;

export function identityConfigFromEnv(): IdentityConfig {
  return {
    userHeader: (process.env.AUTH_USER_HEADER || "x-auth-user").toLowerCase(),
    emailHeader: (process.env.AUTH_EMAIL_HEADER || "x-auth-email").toLowerCase(),
  };
}

export function userFromRequest(req: IncomingMessage, config: IdentityConfig): UserContext {
  return createHeaderResolver(config).resolve(req);
}
