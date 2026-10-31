/**
 * The UI draws every icon from one set, Lucide (lucide-react). This scans the UI source for
 * imports from other icon packages and for emoji or Unicode symbols used as icons, so a
 * second style cannot creep back in. Brand logos, which Lucide does not ship, are the one
 * exception: they come from react-icons, in sourceIcon.tsx only. The Scooter mark itself
 * is brandMark.ts's emoji.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const ROOTS = ["services/ui/src", "services/ui/components", "contrib"];
const SKIP_DIRS = new Set(["node_modules", "dist", "lint-fixture", "__fixtures__"]);

/** The only files that may import brand logos from react-icons. */
const BRAND_LOGO_FILES = new Set(["services/ui/src/sourceIcon.tsx"]);
/** Defines the Scooter mark, the one emoji the UI shows. */
const BRAND_MARK_FILE = "services/ui/src/brandMark.ts";

/** Any package with "icon" in its name, which catches the other icon sets. */
const ICON_PACKAGE = /from\s+["']([^"'.@][^"']*icon[^"']*|@[^/"'][^"']*icon[^"']*)["']/gi;

/**
 * Emoji, plus the symbol blocks that get used as stand-in icons: arrows, technical and
 * geometric shapes, misc symbols, dingbats, ‹ › and the fullwidth ＋. Punctuation such as
 * … and — is text, not an icon, and stays allowed.
 */
const ICON_GLYPH =
  /[\p{Extended_Pictographic}‹›←-⇿⌀-⏿■-◿☀-➿⟰-⟿⤀-⥿⬀-⯿＋]/u;

/** Keyboard keys in shortcut hints ("⌘/Ctrl + Enter") are text, not icons. */
const KEY_GLYPHS = /[\u2318\u2325\u21e7\u2303\u23ce]/gu;

function* sourceFiles(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (!SKIP_DIRS.has(name)) yield* sourceFiles(join(path, name));
    }
  } else if ([".ts", ".tsx"].includes(extname(path)) && !/\.(test|spec)\.tsx?$/.test(path)) {
    yield path;
  }
}

/** Contrib UI code lives in contrib/<name>/ui/ and contrib/<name>/viewer-ui/. */
function isUiFile(rel: string): boolean {
  return !rel.startsWith("contrib/") || /^contrib\/[^/]+\/(ui|viewer-ui)\//.test(rel);
}

/** Blank out comments, which may name a glyph; `//` after a colon is a URL, not a comment. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function uiFiles(): Array<{ rel: string; src: string }> {
  const out = [];
  for (const root of ROOTS) {
    for (const f of sourceFiles(join(REPO, root))) {
      const rel = relative(REPO, f);
      if (isUiFile(rel)) out.push({ rel, src: readFileSync(f, "utf8") });
    }
  }
  return out;
}

describe("one icon set", () => {
  const files = uiFiles();

  it("finds the UI source", () => {
    expect(files.some((f) => f.rel === "services/ui/src/App.tsx")).toBe(true);
    expect(files.some((f) => f.rel.startsWith("contrib/files/viewer-ui/"))).toBe(true);
  });

  it("imports icons only from lucide-react, and brand logos only in sourceIcon.tsx", () => {
    const hits: string[] = [];
    for (const { rel, src } of files) {
      for (const m of src.matchAll(ICON_PACKAGE)) {
        if (m[1].startsWith("react-icons/") && BRAND_LOGO_FILES.has(rel)) continue;
        hits.push(`${rel}: imports ${m[1]}; use lucide-react`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("uses no emoji or Unicode symbol as an icon", () => {
    const hits: string[] = [];
    for (const { rel, src } of files) {
      if (rel === BRAND_MARK_FILE) continue;
      stripComments(src)
        .split("\n")
        .forEach((line, i) => {
          const m = ICON_GLYPH.exec(line.replace(KEY_GLYPHS, ""));
          if (m) hits.push(`${rel}:${i + 1}: "${m[0]}"; draw it with a lucide-react icon`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("flags the glyphs and packages it is meant to", () => {
    for (const g of ["🔒", "⚙", "★", "▸", "↗", "✓", "✕", "＋", "›"]) {
      expect(ICON_GLYPH.test(g), g).toBe(true);
    }
    for (const t of ["Loading…", "Queued — sends", "it's"]) expect(ICON_GLYPH.test(t), t).toBe(false);
    const pkg = (p: string) => [...`import { A } from "${p}";`.matchAll(ICON_PACKAGE)].length > 0;
    for (const p of ["react-icons/fi", "@phosphor-icons/react", "@tabler/icons-react", "@heroicons/react/24/outline"]) {
      expect(pkg(p), p).toBe(true);
    }
    for (const p of ["lucide-react", "./sourceIcon.js", "@/src/sourceIcon"]) expect(pkg(p), p).toBe(false);
  });
});
