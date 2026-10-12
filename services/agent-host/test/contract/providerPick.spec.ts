// An explicit provider pick must outrank priority.

import { describe, it, expect } from "vitest";
import { pickAcpProvider, type AcpProvider, type RunContext } from "../../src/acp/provider.js";

const stub = (id: string, priority: number, eligible = true): AcpProvider =>
  ({
    id,
    priority,
    eligible: () => eligible,
    createClient: () => ({}) as never,
  }) as unknown as AcpProvider;

const BYOC = () => stub("remote-personalized", 10);
const CLOUD = () => stub("sdk-claude", 0);

describe("pickAcpProvider: an explicit pick outranks priority", () => {
  const ctx = (over: Partial<RunContext> = {}): RunContext => ({
    conversationId: "c1" as never,
    owner: "alice",
    ...over,
  });

  it("without a pick, the highest priority still wins (unchanged)", async () => {
    const p = await pickAcpProvider([CLOUD(), BYOC()], ctx());
    expect(p?.id).toBe("remote-personalized");
  });

  it("REGRESSION: picking the LOWER-priority provider moves the run", async () => {
    // An explicit sdk-claude pick wins over the higher-priority BYOC provider.
    const p = await pickAcpProvider([CLOUD(), BYOC()], ctx({ provider: "sdk-claude" }));
    expect(p?.id).toBe("sdk-claude");
  });

  it("picking the higher-priority provider also works", async () => {
    const p = await pickAcpProvider([CLOUD(), BYOC()], ctx({ provider: "remote-personalized" }));
    expect(p?.id).toBe("remote-personalized");
  });

  it("an INELIGIBLE pick falls back to priority rather than failing the run", async () => {
    // A chosen provider that cannot serve this run falls back to priority order.
    const p = await pickAcpProvider(
      [CLOUD(), stub("remote-personalized", 10, false)],
      ctx({ provider: "remote-personalized" }),
    );
    expect(p?.id).toBe("sdk-claude");
  });

  it("a pick naming an UNKNOWN provider is ignored, not fatal", async () => {
    const p = await pickAcpProvider([CLOUD(), BYOC()], ctx({ provider: "no-such-provider" }));
    expect(p?.id).toBe("remote-personalized");
  });
});
