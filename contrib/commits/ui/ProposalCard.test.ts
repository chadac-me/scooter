/** The commits.identity card's shape check, which sends anything else to the plain card. */

import { describe, expect, it } from "vitest";

import { proposedOf } from "./ProposalCard.js";

describe("proposedOf", () => {
  it("reads a proposal", () => {
    expect(proposedOf({ name: "Ada", email: "ada@x.dev" })).toEqual({ name: "Ada", email: "ada@x.dev" });
  });
  it.each([null, {}, { name: "Ada" }, { name: "", email: "a@b" }, { name: 1, email: "a@b" }])("refuses %j", (d) => {
    expect(proposedOf(d)).toBeNull();
  });
});
