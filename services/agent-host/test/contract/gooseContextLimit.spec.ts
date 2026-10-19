/**
 * goose's context window is deployer-declarable: a per-model contextLimit in the catalog
 * reaches goose as GOOSE_CONTEXT_LIMIT for the conversation's resolved model, a pod-level
 * GOOSE_CONTEXT_LIMIT is forwarded and wins, and AGENT_ENV_PASSTHROUGH extends the
 * allowlist of env vars forwarded to goose.
 */
import { describe, it, expect } from "vitest";

import { catalogFromEnv, contextLimitOf } from "../../src/agent/models.js";
import { bedrockEnv, gooseLaunchEnv } from "../../src/index.js";

const catalog = catalogFromEnv({
  AGENT_MODELS_JSON: JSON.stringify([
    { id: "opus-5-5", contextLimit: 1_000_000, default: true },
    { id: "haiku", contextLimit: 200_000 },
    { id: "sonnet" },
  ]),
} as NodeJS.ProcessEnv);

describe("catalog contextLimit", () => {
  it("parses a positive integer contextLimit per model", () => {
    expect(contextLimitOf(catalog, "opus-5-5")).toBe(1_000_000);
    expect(contextLimitOf(catalog, "haiku")).toBe(200_000);
    expect(contextLimitOf(catalog, "sonnet")).toBeUndefined();
    expect(contextLimitOf(catalog, "unknown")).toBeUndefined();
    expect(contextLimitOf(catalog, undefined)).toBeUndefined();
  });

  it.each([0, -1, 1.5, "1000000", null, Number.POSITIVE_INFINITY])("drops an invalid contextLimit (%s)", (v) => {
    const c = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([{ id: "m", contextLimit: v }]),
    } as NodeJS.ProcessEnv);
    expect(c.models[0]).not.toHaveProperty("contextLimit");
  });
});

describe("gooseLaunchEnv", () => {
  const base = { GOOSE_PROVIDER: "aws_bedrock", GOOSE_MODEL: "opus-5-5" };

  it("sets GOOSE_MODEL and the resolved model's GOOSE_CONTEXT_LIMIT", () => {
    expect(gooseLaunchEnv(base, catalog, "haiku")).toEqual({
      GOOSE_PROVIDER: "aws_bedrock",
      GOOSE_MODEL: "haiku",
      GOOSE_CONTEXT_LIMIT: "200000",
    });
    expect(gooseLaunchEnv(base, catalog, "opus-5-5").GOOSE_CONTEXT_LIMIT).toBe("1000000");
  });

  it("leaves GOOSE_CONTEXT_LIMIT unset for a model without one (goose's table decides)", () => {
    expect(gooseLaunchEnv(base, catalog, "sonnet")).not.toHaveProperty("GOOSE_CONTEXT_LIMIT");
  });

  it("lets an explicit pod-level GOOSE_CONTEXT_LIMIT win over the per-model value", () => {
    const env = gooseLaunchEnv({ ...base, GOOSE_CONTEXT_LIMIT: "500000" }, catalog, "haiku");
    expect(env.GOOSE_CONTEXT_LIMIT).toBe("500000");
  });
});

describe("bedrockEnv", () => {
  it("forwards GOOSE_CONTEXT_LIMIT", () => {
    const env = bedrockEnv({ GOOSE_CONTEXT_LIMIT: "1000000" } as NodeJS.ProcessEnv);
    expect(env.GOOSE_CONTEXT_LIMIT).toBe("1000000");
  });

  it("forwards only allowlisted vars by default", () => {
    const env = bedrockEnv({ AWS_REGION: "us-east-1", GOOSE_MAX_TURNS: "50" } as NodeJS.ProcessEnv);
    expect(env).toEqual({ AWS_REGION: "us-east-1", GOOSE_AUTO_COMPACT_THRESHOLD: "0.8" });
  });

  it("forwards the extra names listed in AGENT_ENV_PASSTHROUGH, when set", () => {
    const env = bedrockEnv({
      AGENT_ENV_PASSTHROUGH: "GOOSE_MAX_TURNS, GOOSE_TOOLSHIM\nUNSET_VAR",
      GOOSE_MAX_TURNS: "50",
      GOOSE_TOOLSHIM: "1",
      SECRET: "nope",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({
      GOOSE_MAX_TURNS: "50",
      GOOSE_TOOLSHIM: "1",
      GOOSE_AUTO_COMPACT_THRESHOLD: "0.8",
    });
  });
});
