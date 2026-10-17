// Helpers for the rendered-markdown view: source-line tagging, question blocks,
// and mapping a selection in the rendered page back to a quote in the source.

import type { Root, Element, ElementContent, RootContent } from "hast";

/** A rehype plugin tagging every element with the source line it starts on. */
export function rehypeSourceLines(opts: { offset: number }) {
  return (tree: Root) => {
    const walk = (node: Root | RootContent | ElementContent) => {
      if (node.type === "element") {
        const el = node as Element;
        const line = el.position?.start.line;
        if (line) el.properties = { ...el.properties, dataLine: line + opts.offset };
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

/**
 * The selection as an anchor the server can verify against the source.
 *
 * Rendered text drops markup (`**`, link targets, soft line breaks), so the selection
 * is not always in the source verbatim. Then the longest run of its words that is
 * becomes the quote, which is still unique enough to re-find and highlight.
 */
export function sourceAnchor(source: string, blockLine: number, selected: string) {
  const lines = source.split("\n");
  const text = selected.replace(/\s+/g, " ").trim();
  const found = (q: string) => q.length > 0 && source.includes(q);
  let quote = "";
  if (found(text)) quote = text;
  else {
    const words = text.split(" ");
    for (let len = words.length; len > 0 && !quote; len--)
      for (let i = 0; i + len <= words.length; i++) {
        const q = words.slice(i, i + len).join(" ");
        if (q.length >= 3 && found(q)) {
          quote = q;
          break;
        }
      }
  }
  // The block's own line, or the first line at or after it that holds the quote.
  let line = blockLine;
  if (quote) {
    const at = lines.findIndex((l, i) => i >= blockLine - 1 && l.includes(quote));
    if (at !== -1) line = at + 1;
  }
  return { line, quote };
}

/** A DOM Range over the first occurrence of `quote` in `root`'s text, if any. */
export function findText(root: Node, quote: string): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let all = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    all += (n as Text).data;
  }
  const at = all.indexOf(quote);
  if (at === -1) return null;
  const range = document.createRange();
  let pos = 0;
  let started = false;
  for (const n of nodes) {
    const len = n.data.length;
    if (!started && at < pos + len) {
      range.setStart(n, at - pos);
      started = true;
    }
    if (started && at + quote.length <= pos + len) {
      range.setEnd(n, at + quote.length - pos);
      return range;
    }
    pos += len;
  }
  return null;
}
