/**
 * Tier 1: deriving the controller's HTTP base from the WS connect URL. The container is
 * given one url (`--url ws://host/byoc/ws/<session-id>`) and must find the sibling
 * `/byoc/devices` and `/byoc/challenge` routes from it.
 */

import { describe, it, expect } from "vitest";

/** Mirrors the expression in main.ts. */
function httpBaseFor(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http").replace(/\/ws\/[^/]*\/?$/, "");
}

describe("controller HTTP base from the WS url", () => {
  it("points registration at /byoc/devices, NOT /byoc/ws/devices", () => {
    const base = httpBaseFor("ws://byoc.odin.lan/byoc/ws/2dda98b6-2363-4311");
    expect(base).toBe("http://byoc.odin.lan/byoc");
    expect(`${base}/devices`).toBe("http://byoc.odin.lan/byoc/devices");
    expect(`${base}/devices`, "the 404 that silently disabled device auth").not.toContain("/ws/");
  });

  it("points the challenge at /byoc/challenge", () => {
    const base = httpBaseFor("ws://byoc.odin.lan/byoc/ws/abc");
    expect(`${base}/challenge`).toBe("http://byoc.odin.lan/byoc/challenge");
  });

  it("upgrades wss -> https (a TLS deployment must not fall back to plaintext)", () => {
    expect(httpBaseFor("wss://scooter.example.com/byoc/ws/xyz")).toBe("https://scooter.example.com/byoc");
  });

  it("tolerates a trailing slash", () => {
    expect(httpBaseFor("ws://h/byoc/ws/abc/")).toBe("http://h/byoc");
  });

  it("leaves a url that is already a base alone (no /ws/<id> tail to strip)", () => {
    // An operator pointing --url straight at the base should not have a segment eaten.
    expect(httpBaseFor("ws://h/byoc")).toBe("http://h/byoc");
  });
});
