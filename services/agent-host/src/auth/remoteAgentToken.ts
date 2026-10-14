/**
 * Join tokens for bring-your-own-Claude remote agents: a short-lived, owner-bound
 * HS256 token the UI mints and the connect handshake verifies offline, with an
 * audience that stops it being replayed as a conversation token.
 */

import { randomUUID } from "node:crypto";

import { signHs256, verifyHs256 } from "./hs256.js";

const AUDIENCE = "remote-agent";

export interface JoinClaims {
  /** The Scooter user the agent is bound to. */
  owner: string;
  /** Seconds-since-epoch expiry. */
  exp: number;
  /** Issued-at (seconds). */
  iat: number;
  /** Single-use nonce, a replay marker the connect side may track. */
  nonce: string;
  /** Audience, always "remote-agent", so a token minted for something else cannot be replayed here. */
  aud: string;
}

/** Mint a short-lived owner-bound join token; `ttlSeconds` defaults to 10 min. */
export function mintJoinToken(owner: string, secret: string, opts: { ttlSeconds?: number; now?: number } = {}): string {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const claims: JoinClaims = {
    owner,
    iat: now,
    exp: now + (opts.ttlSeconds ?? 600),
    nonce: randomUUID(),
    aud: AUDIENCE,
  };
  return signHs256(claims, secret);
}

export type VerifyResult =
  | { ok: true; claims: JoinClaims }
  | { ok: false; reason: string };

/** Verify a join token's signature, audience and expiry, returning the claims on success; never throws. */
export function verifyJoinToken(token: string, secret: string, now: number = Math.floor(Date.now() / 1000)): VerifyResult {
  const res = verifyHs256<JoinClaims>(token, secret);
  if (!res.ok) return res;
  const claims = res.claims;
  if (claims.aud !== AUDIENCE) return { ok: false, reason: "wrong audience" };
  if (typeof claims.owner !== "string" || !claims.owner) return { ok: false, reason: "no owner" };
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
