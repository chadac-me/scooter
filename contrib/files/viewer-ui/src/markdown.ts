// Helpers for the rendered-markdown view: source-line tagging, question blocks,
// and mapping a selection in the rendered page back to a quote in the source.

import type { Root, Element, ElementContent, RootContent } from "hast";

/** A rehype plugin tagging every element with the source lines it starts and ends on. */
export function rehypeSourceLines(opts: { offset: number }) {
  return (tree: Root) => {
    const walk = (node: Root | RootContent | ElementContent) => {
      if (node.type === "element") {
        const el = node as Element;
        const start = el.position?.start.line;
        const end = el.position?.end.line;
        if (start) el.properties = { ...el.properties, dataLine: start + opts.offset };
        if (end) el.properties = { ...el.properties, dataLineEnd: end + opts.offset };
      }
      if ("children" in node) node.children.forEach(walk);
    };
    walk(tree);
  };
}

export type Segment =
  | { kind: "md"; text: string; offset: number }
  | { kind: "question"; id: string; line: number; text: string; offset: number };

// These mirror viewer/questions.py; a block either side reads differently renders raw.
const OPEN = /^\s*<!--\s*scooter:question\s+([^>]*?)\s*-->\s*$/;
const CLOSE = /^\s*<!--\s*\/scooter:question\s*-->\s*$/;
const FENCE = /^\s*(```+|~~~+)/;
const INDENTED = /^(?: {4}|\t)/;
const ID = /(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/;

/** The document cut at question blocks, each piece remembering where it started. */
export function segments(body: string): Segment[] {
  const lines = body.split("\n");
  const out: Segment[] = [];
  let start = 0;
  let fence = "";
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(FENCE);
    if (f && (!fence || f[1][0] === fence[0])) {
      fence = fence ? "" : f[1];
      continue;
    }
    if (fence || INDENTED.test(lines[i])) continue;
    const open = lines[i].match(OPEN);
    if (!open) continue;
    const end = lines.findIndex((l, j) => j > i && CLOSE.test(l));
    if (end === -1) continue;
    const m = open[1].match(ID);
    const id = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
    if (i > start) out.push({ kind: "md", text: lines.slice(start, i).join("\n"), offset: start });
    out.push({ kind: "question", id, line: i + 1, text: lines.slice(i + 1, end).join("\n"), offset: i + 1 });
    start = end + 1;
    i = end;
  }
  if (start < lines.length) out.push({ kind: "md", text: lines.slice(start).join("\n"), offset: start });
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What may sit between two rendered words in the source: whitespace (a soft wrap is a
// newline), inline markup, a link's target, a list or quote marker at a line's start.
const GAP = String.raw`(?:\s|[*_~\x60>|#\[\]]|\]\([^)]*\)|(?<=\n[ \t]*)(?:[-+]|\d+[.)])(?=\s))*`;
// What may sit inside one: a word can butt against markup, as in **bold**, or [link](x).
const INLINE = String.raw`(?:[*_~\x60\[\]]|\]\([^)]*\))*`;

/**
 * The selection as an anchor the server can verify against the source.
 *
 * Rendered text drops markup (`**`, link targets, soft line breaks), so the selection
 * is rarely in the source verbatim. Its words are matched in order with any markup
 * between them, and the quote is the source text that spans them, so a selection
 * across a hard-wrapped paragraph quotes all of it. Failing that, the longest run of
 * words found verbatim stands in, which is still unique enough to re-find.
 */
export function sourceAnchor(source: string, blockLine: number, selected: string) {
  const lines = source.split("\n");
  const words = selected.split(/\s+/).filter(Boolean);
  // The search starts at the selection's block, so a phrase repeated earlier is skipped.
  const from = lines.slice(0, Math.max(0, blockLine - 1)).reduce((n, l) => n + l.length + 1, 0);
  let quote = "";
  if (words.length) {
    const re = new RegExp(words.map((w) => [...w].map(escape).join(INLINE)).join(GAP), "g");
    re.lastIndex = from;
    const m = re.exec(source) ?? ((re.lastIndex = 0), re.exec(source));
    if (m) quote = m[0];
  }
  if (!quote)
    for (let len = words.length; len > 0 && !quote; len--)
      for (let i = 0; i + len <= words.length; i++) {
        const q = words.slice(i, i + len).join(" ");
        if (q.length >= 3 && source.includes(q)) {
          quote = q;
          break;
        }
      }
  return { line: quote ? lineOf(source, quote, blockLine) : blockLine, quote };
}

/** The line a quote starts on: its first occurrence at or after `near`, else anywhere. */
function lineOf(source: string, quote: string, near: number): number {
  const lines = source.split("\n");
  const from = lines.slice(0, Math.max(0, near - 1)).reduce((n, l) => n + l.length + 1, 0);
  let at = source.indexOf(quote, from);
  if (at === -1) at = source.indexOf(quote);
  return at === -1 ? near : source.slice(0, at).split("\n").length;
}

/** A source block's own text, lines `start` to `end`, as a paragraph comment quotes it. */
export function blockSource(source: string, start: number, end: number): string {
  return source
    .split("\n")
    .slice(start - 1, end)
    .join("\n")
    .trim();
}

/**
 * A quote as it reads rendered: link targets, inline markup and line-start markers
 * dropped. Underscores and asterisks inside a word (snake_case) are kept.
 */
export function plainOf(quote: string): string {
  return quote
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:[-+*]|\d+[.)]|>|#{1,6})[ \t]+/gm, "")
    .replace(/(^|[\s([{"'])[*_~\x60]+/g, "$1")
    .replace(/[*_~\x60]+(?=$|[\s)\]}.,;:!?"'])/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The elements a paragraph comment attaches to; inline elements resolve to these. */
export const BLOCKS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "table", "div[data-code]"]
  .map((s) => `${s}[data-line]`)
  .join(", ");

/** The innermost block whose source lines hold `line`. */
export function blockAt(root: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let span = Infinity;
  root.querySelectorAll<HTMLElement>(BLOCKS).forEach((el) => {
    const start = Number(el.dataset.line);
    const end = Number(el.dataset.lineEnd ?? start);
    if (start <= line && line <= end && end - start <= span) {
      best = el;
      span = end - start;
    }
  });
  return best;
}

/**
 * A DOM Range over the first occurrence of `quote` in `root`'s text, if any. Runs of
 * whitespace match any run of whitespace, as a soft wrap renders as a newline.
 */
export function findText(root: Node, quote: string): Range | null {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  // The root's text with whitespace collapsed, and where each character came from.
  let flat = "";
  const from: [Text, number][] = [];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null)
    for (let i = 0; i < n.data.length; i++) {
      const ws = /\s/.test(n.data[i]);
      if (ws && (flat.endsWith(" ") || !flat)) continue;
      flat += ws ? " " : n.data[i];
      from.push([n, i]);
    }
  const at = flat.indexOf(needle);
  if (at === -1) return null;
  const [sn, so] = from[at];
  const [en, eo] = from[at + needle.length - 1];
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo + 1);
  return range;
}

/**
 * A quote as the comment rail shows it. Prose reads as rendered; a fenced block shows
 * its code untouched (markup stripping would eat a `**` operator); a table shows its
 * cells, without the pipes and the separator row.
 */
export function previewOf(quote: string): string {
  const lines = quote.split("\n");
  const fence = /^\s*(`{3,}|~{3,})/.exec(lines[0]);
  if (fence) {
    const body = lines.slice(1);
    if (body.length && body[body.length - 1].trim().startsWith(fence[1])) body.pop();
    return body.join(" ").replace(/\s+/g, " ").trim();
  }
  if (lines.every((l) => l.trim().startsWith("|")))
    return lines
      .filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l))
      .map((l) => plainOf(l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join(" · ")))
      .join(" / ");
  return plainOf(quote);
}
