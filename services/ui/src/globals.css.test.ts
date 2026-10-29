/**
 * The UI's Tailwind scan reaches every contrib card, since a production build styles only
 * the classes it scans and a bare directory in `@source` matches no files.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const base = fileURLToPath(new URL(".", import.meta.url));

describe("globals.css @source", () => {
  it("scans the contrib cards, so their classes reach the built CSS", async () => {
    const css = readFileSync(`${base}globals.css`, "utf8");
    const compiled = await compile(css, { base, onDependency: () => {} });
    const scanner = new Scanner({ sources: compiled.sources });
    const candidates = scanner.scan();

    const cards = scanner.files.filter((f) => /\/contrib\/[^/]+\/ui\/[^/]+\.tsx$/.test(f));
    expect(cards.some((f) => f.endsWith("/contrib/aws/ui/PermissionsCard.tsx"))).toBe(true);
    expect(cards.some((f) => f.endsWith("/contrib/ask-user/ui/QuestionCard.tsx"))).toBe(true);
    // Used only by the ask-user card's detail view.
    expect(candidates).toContain("md:grid-cols-2");
  });
});
