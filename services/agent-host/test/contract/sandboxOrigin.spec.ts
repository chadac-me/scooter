import { describe, expect, it } from "vitest";

import {
  sandboxLabel,
  sandboxOrigin,
  sandboxOriginsFromEnv,
  servicePrefix,
  serviceUrl,
} from "../../src/proxy/sandboxOrigin.js";

const ID = "5A515E73-860b-49ba-bc3f-6ff8d5fda5ff";
const ORIGINS = { domain: "scooter.example.com", scheme: "https" };

describe("sandbox origins", () => {
  it("reads SANDBOX_DOMAIN with PUBLIC_URL's scheme, and is off without it", () => {
    expect(sandboxOriginsFromEnv({})).toBeUndefined();
    expect(sandboxOriginsFromEnv({ SANDBOX_DOMAIN: "Scooter.Example.com." })).toEqual(ORIGINS);
    expect(sandboxOriginsFromEnv({ SANDBOX_DOMAIN: "localtest.me", PUBLIC_URL: "http://localtest.me:8080" }))
      .toEqual({ domain: "localtest.me", scheme: "http" });
  });

  it("labels a conversation by the first 8 hex characters of its id, lowercased", () => {
    expect(sandboxLabel(ID)).toBe("5a515e73");
    expect(sandboxLabel("conv-1")).toBeUndefined();
    expect(sandboxLabel("5a515e7")).toBeUndefined();
  });

  it("builds the service URL on the conversation's own origin", () => {
    expect(sandboxOrigin(ID, ORIGINS)).toBe("https://5a515e73.scooter.example.com");
    expect(serviceUrl(ID, "marimo", ORIGINS)).toBe("https://5a515e73.scooter.example.com/marimo/");
    expect(servicePrefix(ID, ORIGINS)).toBe("");
  });

  it("falls back to the main-host path when off, or when the id can't be a label", () => {
    expect(serviceUrl(ID, "marimo", undefined)).toBe(`/c/${ID}/marimo/`);
    expect(servicePrefix(ID, undefined)).toBe(`/c/${ID}`);
    expect(serviceUrl("conv-1", "files", ORIGINS)).toBe("/c/conv-1/files/");
  });
});
