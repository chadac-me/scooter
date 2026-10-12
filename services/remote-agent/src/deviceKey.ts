/**
 * The container's device identity, an Ed25519 keypair that lives only on this machine.
 * The join token is used once to register the public key; every later connect signs a
 * server-issued nonce with the private key, which never leaves the volume. It is persisted
 * next to the Claude setup-token at mode 0600.
 */

import { generateKeyPairSync, createPrivateKey, sign as cryptoSign } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** Where the device identity lives, in the same directory as the Claude token. */
export function deviceKeyPath(): string {
  return process.env.SCOOTER_DEVICE_KEY_PATH ?? join(homedir(), ".claude", "device-key.json");
}

export interface DeviceIdentity {
  /** Assigned by the controller at registration. */
  deviceId: string;
  /** PKCS#8 PEM, never sent anywhere. */
  privateKeyPem: string;
  /** SPKI PEM, what the cloud stores. */
  publicKeyPem: string;
}

/** A freshly generated keypair, not yet registered. */
export interface UnregisteredKey {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateDeviceKey(): UnregisteredKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Load the stored identity, or undefined if this container has never registered. */
export async function loadDeviceIdentity(): Promise<DeviceIdentity | undefined> {
  try {
    const raw = await readFile(deviceKeyPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DeviceIdentity>;
    if (!parsed.deviceId || !parsed.privateKeyPem || !parsed.publicKeyPem) return undefined;
    // A corrupt key file must fall back to re-registration rather than crash-loop the container.
    createPrivateKey(parsed.privateKeyPem);
    return parsed as DeviceIdentity;
  } catch {
    return undefined;
  }
}

export async function saveDeviceIdentity(identity: DeviceIdentity): Promise<void> {
  const p = deviceKeyPath();
  await mkdir(dirname(p), { recursive: true });
  // 0600: the private key is the whole credential.
  await writeFile(p, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
}

/** Sign a server-issued challenge nonce; Ed25519 takes no digest argument. */
export function signChallenge(privateKeyPem: string, nonce: string): string {
  return cryptoSign(null, Buffer.from(nonce), createPrivateKey(privateKeyPem)).toString("base64");
}
