/**
 * Conversation tokens: the HS256-signed claim that "this caller is acting for
 * conversation X", minted by the agent-host and verified by both MCP servers (the
 * agent-host's own endpoint and the broker's). The TTL defaults to days rather than
 * minutes because the token is handed to the agent at session creation and a token
 * that expires mid-conversation surfaces as tools that start failing. A minted token
 * must never go into a session fingerprint, since `iat` differs on every mint.
 */

import { signHs256, verifyHs256 } from "./hs256.js";

/** Audience, pinned so a BYOC join token can never be replayed as a conversation token and vice versa. */
export const CONV_TOKEN_AUDIENCE = "scooter-mcp";

/** Issuer, carried so the broker can say which component vouched for the id. */
export const CONV_TOKEN_ISSUER = "scooter-agent-host";

/** 7 days; override with CONV_TOKEN_TTL_SECONDS. */
export const DEFAULT_CONV_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ConvClaims {
  /** Audience, always CONV_TOKEN_AUDIENCE. */
  aud: string;
  /** Issuer, always CONV_TOKEN_ISSUER. */
  iss: string;
  /** The conversation this caller may act for. */
  sub: string;
  /** The Scooter user who owns the conversation, when known, so a tool can scope by owner without a lookup. */
  owner?: string;
  /** Seconds-since-epoch expiry. */
  exp: number;
  /** Issued-at (seconds). */
  iat: number;
}

/** Mint a token binding the bearer to one conversation. */
export function mintConvToken(
  conversationId: string,
  secret: string,
  opts: { owner?: string; ttlSeconds?: number; now?: number } = {},
): string {
  if (!conversationId) throw new Error("mintConvToken: conversationId is required");
  if (!secret) throw new Error("mintConvToken: secret is required");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const claims: ConvClaims = {
    aud: CONV_TOKEN_AUDIENCE,
    iss: CONV_TOKEN_ISSUER,
    sub: conversationId,
    iat: now,
    exp: now + (opts.ttlSeconds ?? DEFAULT_CONV_TOKEN_TTL_SECONDS),
    ...(opts.owner ? { owner: opts.owner } : {}),
  };
  return signHs256(claims, secret);
}

export type ConvTokenResult =
  | { ok: true; conversationId: string; owner?: string }
  | { ok: false; reason: string };

/** Verify a conversation token (signature, audience, issuer, expiry, non-empty subject) without ever throwing. */
export function verifyConvToken(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): ConvTokenResult {
  if (!secret) return { ok: false, reason: "no conversation-token secret configured" };
  const res = verifyHs256<ConvClaims>(token, secret);
  if (!res.ok) return res;
  const c = res.claims;
  if (c.aud !== CONV_TOKEN_AUDIENCE) return { ok: false, reason: "wrong audience" };
  if (c.iss !== CONV_TOKEN_ISSUER) return { ok: false, reason: "wrong issuer" };
  if (typeof c.sub !== "string" || !c.sub) return { ok: false, reason: "no conversation" };
  if (typeof c.exp !== "number" || c.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, conversationId: c.sub, ...(c.owner ? { owner: c.owner } : {}) };
}

/** Read a Bearer token out of an Authorization header value; the token travels in a header, never the URL, which gets logged. */
export function bearerFrom(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const m = /^bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1].trim() : undefined;
}
