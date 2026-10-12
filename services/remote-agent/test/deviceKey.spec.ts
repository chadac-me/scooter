/**
 * Tier 1 contract for the container's device identity: the key persists across restarts,
 * a corrupt file degrades to re-registration rather than a crash-loop, and the signature
 * verifies against the public half the cloud stored.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import {
  generateDeviceKey,
  loadDeviceIdentity,
  saveDeviceIdentity,
  signChallenge,
  deviceKeyPath,
} from "../src/deviceKey.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-key-"));
  process.env.SCOOTER_DEVICE_KEY_PATH = join(dir, "device-key.json");
});
afterEach(() => {
  delete process.env.SCOOTER_DEVICE_KEY_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("container device key", () => {
  it("generates an Ed25519 keypair whose signature verifies against the public half", () => {
    const key = generateDeviceKey();
    const nonce = "server-issued-nonce";
    const sig = signChallenge(key.privateKeyPem, nonce);
    // What the controller does on the other end.
    const ok = cryptoVerify(null, Buffer.from(nonce), createPublicKey(key.publicKeyPem), Buffer.from(sig, "base64"));
    expect(ok).toBe(true);
  });

  it("a signature does NOT verify against a different key", () => {
    const a = generateDeviceKey();
    const b = generateDeviceKey();
    const nonce = "n";
    const sig = signChallenge(a.privateKeyPem, nonce);
    expect(cryptoVerify(null, Buffer.from(nonce), createPublicKey(b.publicKeyPem), Buffer.from(sig, "base64"))).toBe(false);
  });

  it("a signature is bound to ITS nonce (signing one does not authenticate another)", () => {
    const key = generateDeviceKey();
    const sig = signChallenge(key.privateKeyPem, "nonce-one");
    expect(
      cryptoVerify(null, Buffer.from("nonce-two"), createPublicKey(key.publicKeyPem), Buffer.from(sig, "base64")),
    ).toBe(false);
  });

  it("PERSISTS across a restart — the whole point of storing it in the volume", async () => {
    const key = generateDeviceKey();
    await saveDeviceIdentity({ deviceId: "dev-1", ...key });
    // A restart is a fresh read of the same path.
    const loaded = await loadDeviceIdentity();
    expect(loaded?.deviceId).toBe("dev-1");
    expect(loaded?.privateKeyPem).toBe(key.privateKeyPem);
    // The reloaded key must still sign verifiably.
    const sig = signChallenge(loaded!.privateKeyPem, "n");
    expect(cryptoVerify(null, Buffer.from("n"), createPublicKey(loaded!.publicKeyPem), Buffer.from(sig, "base64"))).toBe(true);
  });

  it("writes the key file 0600 — it is the whole credential", async () => {
    await saveDeviceIdentity({ deviceId: "dev-1", ...generateDeviceKey() });
    expect(statSync(deviceKeyPath()).mode & 0o777).toBe(0o600);
  });

  it("returns undefined when this container has NEVER registered", async () => {
    expect(await loadDeviceIdentity()).toBeUndefined();
  });

  it("a CORRUPT key file degrades to re-registration, never a crash-loop", async () => {
    // A throw here would spin the restarting container forever.
    writeFileSync(deviceKeyPath(), "{ this is not json");
    expect(await loadDeviceIdentity()).toBeUndefined();
  });

  it("a file missing fields degrades to re-registration", async () => {
    writeFileSync(deviceKeyPath(), JSON.stringify({ deviceId: "dev-1" }));
    expect(await loadDeviceIdentity()).toBeUndefined();
  });

  it("a file whose private key is unparseable degrades to re-registration", async () => {
    // A truncated key must not throw on load.
    writeFileSync(
      deviceKeyPath(),
      JSON.stringify({ deviceId: "dev-1", privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----", publicKeyPem: "x" }),
    );
    expect(await loadDeviceIdentity()).toBeUndefined();
  });
});
