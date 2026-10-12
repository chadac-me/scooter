/**
 * Optional AWS ALB OIDC JWT signature verification, applied as an async wrapper over
 * the alb-oidc resolver: it fetches ALB's public key for the JWT's `kid` from
 * https://public-keys.auth.elb.<region>.amazonaws.com/<kid> (cached by kid) and
 * verifies the ES256 signature. On failure the email/name claims are dropped while
 * the sub from the separate identity header still identifies the user; nothing
 * throws into the request path.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { logger } from "../log.js";

import type { AsyncIdentityResolver, UserContext } from "./identity.js";

const log = logger("albVerify");

export interface AlbVerifyConfig {
  region: string;
  /** The data header to verify (default "x-amzn-oidc-data"). */
  dataHeader?: string;
  /** Injectable key fetcher returning the PEM for a kid. */
  fetchKey?: (kid: string, region: string) => Promise<string | undefined>;
}

/** Base64url-decode to a Buffer. */
function b64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Parse the JWT header segment, or {} on failure. */
function jwtHeader(token: string): Record<string, unknown> {
  const seg = token.split(".")[0];
  if (!seg) return {};
  try {
    return JSON.parse(b64url(seg).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Default key fetcher: GET the regional ALB public-key endpoint. */
async function defaultFetchKey(kid: string, region: string): Promise<string | undefined> {
  const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${encodeURIComponent(kid)}`;
  const res = await fetch(url);
  if (!res.ok) return undefined;
  return (await res.text()).trim();
}

/** Verify an ALB OIDC JWT's ES256 signature against the key for its kid, false on any error. */
export async function verifyAlbJwt(
  token: string,
  keyFor: (kid: string) => Promise<string | undefined>,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const kid = jwtHeader(token).kid;
  if (typeof kid !== "string" || !kid) return false;
  try {
    const pem = await keyFor(kid);
    if (!pem) return false;
    const key = createPublicKey(pem);
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const signature = b64url(parts[2]);
    // The JWS signature is raw R||S, which crypto.verify accepts with dsaEncoding "ieee-p1363".
    return cryptoVerify("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}

/** A kid-to-PEM cache over a fetcher. */
export function createKeyCache(fetchKey: (kid: string, region: string) => Promise<string | undefined>, region: string) {
  const cache = new Map<string, string>();
  return async (kid: string): Promise<string | undefined> => {
    const hit = cache.get(kid);
    if (hit) return hit;
    const pem = await fetchKey(kid, region).catch(() => undefined);
    if (pem) cache.set(kid, pem);
    return pem;
  };
}

/** Wrap an IdentityResolver so the ALB data JWT's signature is verified, dropping the claims but keeping the sub-based id on failure. */
export function withAlbVerification(
  resolver: AsyncIdentityResolver,
  config: AlbVerifyConfig,
): { resolve(req: IncomingMessage): Promise<UserContext> } {
  const dataHeader = (config.dataHeader ?? "x-amzn-oidc-data").toLowerCase();
  const keyFor = createKeyCache(config.fetchKey ?? defaultFetchKey, config.region);
  return {
    async resolve(req) {
      const user = await resolver.resolve(req);
      if (user.anonymous) return user;
      const raw = req.headers[dataHeader];
      const token = (Array.isArray(raw) ? raw[0] : raw)?.trim();
      // No JWT means nothing to gate.
      if (!token) return user;
      const ok = await verifyAlbJwt(token, keyFor);
      if (ok) return user;
      // Keep the id from the separate identity header, drop the claims.
      log.warn("x-amzn-oidc-data signature did NOT verify — dropping unverified claims");
      return { id: user.id, anonymous: false };
    },
  };
}
