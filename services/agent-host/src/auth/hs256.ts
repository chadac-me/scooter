/**
 * Minimal HS256 JWT sign/verify on node:crypto, the one primitive behind every token
 * the agent-host mints (BYOC join tokens, conversation tokens). The signing format
 * is a cross-service contract, since the broker verifies conversation tokens in
 * Python; `test/fixtures/conv-token.json` is the frozen vector both suites check.
 * verify() recomputes the HS256 MAC and compares, so no algorithm is ever selected
 * from attacker-controlled input.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const b64url = (buf: Buffer): string => buf.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** The fixed header, emitted for standard JWT parsers and never read back on this side. */
const HEADER = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));

function mac(data: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

/** Sign `claims` as a compact HS256 JWT, written verbatim (expiry, audience and issuer are the caller's to put in); typed `object` so a declared claims interface is assignable. */
export function signHs256(claims: object, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  return `${HEADER}.${payload}.${mac(`${HEADER}.${payload}`, secret)}`;
}

export type Hs256Result<T> = { ok: true; claims: T } | { ok: false; reason: string };

/** Verify the signature and decode the claims, checking nothing else (`exp`, `aud` and the rest are the caller's semantics); never throws. */
export function verifyHs256<T>(token: string, secret: string): Hs256Result<T> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [encHeader, encClaims, sig] = parts;
  const a = fromB64url(sig);
  const b = fromB64url(mac(`${encHeader}.${encClaims}`, secret));
  // timingSafeEqual throws on a length mismatch, so check the length first.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  try {
    return { ok: true, claims: JSON.parse(fromB64url(encClaims).toString("utf8")) as T };
  } catch {
    return { ok: false, reason: "bad claims" };
  }
}
