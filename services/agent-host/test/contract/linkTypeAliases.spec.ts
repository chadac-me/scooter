import { describe, expect, it } from "vitest";

import { canonicalResourceType, parseLinkTypeAliases } from "../../src/session/linkTypeAliases.js";

describe("parseLinkTypeAliases", () => {
  it("reads source -> alias -> canonical, lower-casing aliases", () => {
    expect(parseLinkTypeAliases('{"github":{"PR":"pull_request"}}')).toEqual({ github: { pr: "pull_request" } });
  });

  it("is empty for unset or malformed input, and warns on the latter", () => {
    const warned: string[] = [];
    expect(parseLinkTypeAliases(undefined)).toEqual({});
    expect(parseLinkTypeAliases("{", (m) => warned.push(m))).toEqual({});
    expect(warned).toHaveLength(1);
  });

  it("drops non-string rows and non-object tables", () => {
    expect(parseLinkTypeAliases('{"github":{"pr":1,"issue":"issue"},"slack":[]}')).toEqual({
      github: { issue: "issue" },
    });
  });
});

describe("canonicalResourceType", () => {
  const aliases = { github: { pr: "pull_request" } };

  it("maps a known alias case-insensitively", () => {
    expect(canonicalResourceType(aliases, "github", "PR")).toBe("pull_request");
  });

  it("passes unknown sources and types through", () => {
    expect(canonicalResourceType(aliases, "gitlab", "mr")).toBe("mr");
    expect(canonicalResourceType(aliases, "github", "discussion")).toBe("discussion");
  });
});
