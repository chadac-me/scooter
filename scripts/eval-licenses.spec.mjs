import { describe, expect, it } from "vitest";

import { classify, detectLicenseText } from "./eval-licenses.mjs";

describe("classify", () => {
  it.each([
    ["MIT", "permissive"],
    ["Apache-2.0", "permissive"],
    ["MPL-2.0", "weak-copyleft"],
    ["LGPL-2.1-or-later", "weak-copyleft"],
    ["GPL-3.0-or-later", "strong-copyleft"],
    ["AGPL-3.0-only", "strong-copyleft"],
    ["Sleepycat", "strong-copyleft"],
    ["CC-BY-4.0", "attribution"],
    ["unfree", "proprietary"],
    ["SEE LICENSE IN README.md", "proprietary"],
    ["Made-Up-License", "unknown"],
    [null, "unknown"],
  ])("%s -> %s", (id, cat) => expect(classify(id)).toBe(cat));

  it("takes the least restrictive choice under OR", () => {
    expect(classify("(LGPL-3.0-or-later OR GPL-2.0-or-later)")).toBe("weak-copyleft");
    expect(classify("(MIT OR GPL-2.0-only)")).toBe("permissive");
  });

  it("takes the most restrictive term under AND", () => {
    expect(classify("MIT AND GPL-2.0-or-later")).toBe("strong-copyleft");
    expect(classify("MIT AND ISC AND CC-BY-4.0")).toBe("attribution");
  });
});

describe("detectLicenseText", () => {
  it("recognises common license texts", () => {
    expect(detectLicenseText("Apache License\n  Version 2.0, January 2004")).toBe("Apache-2.0");
    expect(detectLicenseText("Permission is hereby granted, free of charge, to any person")).toBe("MIT");
    expect(detectLicenseText("Neither the name of Google Inc. nor the names of its contributors may be used")).toBe("BSD-3-Clause");
    expect(detectLicenseText("Redistributions in binary form must reproduce the above copyright notice")).toBe("BSD-2-Clause");
    expect(detectLicenseText("Mozilla Public License, version 2.0")).toBe("MPL-2.0");
    expect(detectLicenseText("nothing recognisable")).toBeNull();
  });
});
