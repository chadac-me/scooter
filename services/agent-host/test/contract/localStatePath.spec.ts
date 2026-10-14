/**
 * LOCAL_STATE_PATH names the ephemeral local store (an emptyDir), with STATE_PATH honoured
 * as a transitional fallback so a pod whose manifest predates the rename keeps working.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { configFromEnv } from "../../src/index.js";

const KEYS = ["LOCAL_STATE_PATH", "STATE_PATH", "MIRROR_STATE_PATH"] as const;

describe("LOCAL_STATE_PATH", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("reads LOCAL_STATE_PATH", () => {
    process.env.LOCAL_STATE_PATH = "/tmp/local-cache";
    expect(configFromEnv().localStatePath).toBe("/tmp/local-cache");
  });

  it("still honors the old STATE_PATH so a pre-rename manifest keeps working", () => {
    // A rollout replaces pods one at a time, so an old manifest can still set STATE_PATH when the new image starts.
    process.env.STATE_PATH = "/tmp/legacy";
    expect(configFromEnv().localStatePath).toBe("/tmp/legacy");
  });

  it("prefers LOCAL_STATE_PATH when BOTH are set (the new name wins)", () => {
    process.env.LOCAL_STATE_PATH = "/tmp/new";
    process.env.STATE_PATH = "/tmp/old";
    expect(configFromEnv().localStatePath).toBe("/tmp/new");
  });


  it("falls back to a default when neither is set (dev/local)", () => {
    expect(configFromEnv().localStatePath).toMatch(/\S/);
  });
});
