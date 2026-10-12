/**
 * parseLeadingJson (test/support/cluster.ts), the tolerant parse behind curlJson: output
 * captured from a `kubectl run -i` curl pod can carry a stray line after the payload, so
 * the helper parses the leading JSON value while a malformed payload still throws.
 */

import { describe, it, expect } from "vitest";
import { parseLeadingJson } from "../../../../test/support/cluster.js";

describe("parseLeadingJson", () => {
  it("parses clean JSON unchanged", () => {
    expect(parseLeadingJson('[{"id":"a"}]')).toEqual([{ id: "a" }]);
  });
  it("THE FAILURE SHAPE: valid JSON line 1 + junk line 2", () => {
    expect(parseLeadingJson('[{"id":"a"},{"id":"b"}]\nWarning: attach raced teardown')).toEqual([
      { id: "a" }, { id: "b" },
    ]);
  });
  it("two concatenated JSON docs -> the first wins", () => {
    expect(parseLeadingJson('{"id":"first"}\n{"id":"second"}')).toEqual({ id: "first" });
  });
  it("genuinely malformed still throws the original error", () => {
    expect(() => parseLeadingJson("not json at all")).toThrow(SyntaxError);
  });
});
