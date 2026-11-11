/**
 * Syntax highlighting for fenced code blocks in the thread's markdown
 * (components/assistant-ui/syntax-highlighter.tsx).
 *
 * lowlight runs highlight.js over the code and returns a hast tree, so the colouring is
 * synchronous (a streaming block is coloured on every token with no flash) and never goes
 * through innerHTML. The grammar set is highlight.js's `common` (python, c, cpp, rust,
 * javascript, typescript, json, bash, sql, go, java, …) plus nix and dockerfile;
 * highlight.js aliases (`py`, `js`, `ts`, `sh`, `c++`, `yml`, `html`, `console`) resolve
 * through the registry. A language nobody registered, or a block too large to colour
 * cheaply, returns null and the caller shows plain text.
 */

import { common, createLowlight } from "lowlight";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import nix from "highlight.js/lib/languages/nix";

const lowlight = createLowlight(common);
lowlight.register({ nix, dockerfile });

export type HighlightTree = ReturnType<typeof lowlight.highlight>;

/** Above this many characters a block stays plain: highlighting re-runs on every streamed token. */
export const MAX_HIGHLIGHT_CHARS = 100_000;

/** Fence labels that mean "no language": leave them plain rather than guess. */
const PLAIN = new Set(["", "unknown", "text", "txt", "plain", "plaintext", "none", "output", "log"]);

/** The highlight.js name a fence label resolves to, or undefined when it is plain or unknown. */
export function highlightLanguage(language: string | undefined): string | undefined {
  const lang = language?.trim().toLowerCase() ?? "";
  if (PLAIN.has(lang)) return undefined;
  return lowlight.registered(lang) ? lang : undefined;
}

/** The highlighted hast tree for `code`, or null to render it plain. */
export function highlightCode(language: string | undefined, code: string): HighlightTree | null {
  const lang = highlightLanguage(language);
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    return lowlight.highlight(lang, code);
  } catch {
    return null;
  }
}

/** The registered language names (not aliases), for tests and the docs. */
export function highlightLanguages(): string[] {
  return lowlight.listLanguages();
}
