/** The BYO docker one-liner builder, with the token and url baked in. */

import { describe, it, expect } from "vitest";

import { connectWsUrl, dockerCommand, createRemoteAgentUi } from "../../src/acp/remoteAgentOneliner.js";
import { verifyJoinToken } from "../../src/auth/remoteAgentToken.js";

// connectWsUrl and createRemoteAgentUi are covered in remoteAgentOnelinerByoc.spec.ts.

describe("dockerCommand", () => {
  it("bakes the url + token + the restart-always + volume + 1717 publish", () => {
    const cmd = dockerCommand("wss://s/remote-agent/connect", "TOK", "ghcr.io/x/agent:1");
    expect(cmd).toContain("--restart always");
    expect(cmd).toContain("-p 127.0.0.1:34579:34579");
    expect(cmd).toContain("-v scooter-claude:/root/.claude");
    expect(cmd).toContain("ghcr.io/x/agent:1");
    expect(cmd).toContain("--url wss://s/remote-agent/connect");
    expect(cmd).toContain("--join TOK");
  });
});

