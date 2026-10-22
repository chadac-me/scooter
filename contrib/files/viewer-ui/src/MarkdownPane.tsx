import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";
import { MessageSquare, MessageSquarePlus } from "lucide-react";
import clsx from "clsx";
import { api, BASE, type Question, type Thread } from "./api";
import { hrefFor, isExternal, navigate, resolveRel, slug } from "./nav";
import { BLOCKS, blockAt, blockSource, findText, plainOf, previewOf, rehypeSourceLines, segments, sourceAnchor } from "./markdown";
import { Composer, Quote, ThreadCard } from "./Thread";
import { QuestionCard } from "./Questions";

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let live = true;
    codeToHtml(code, {
      lang: lang || "text",
      themes: { light: "solarized-light", dark: "solarized-dark" },
      defaultColor: false,
    })
      .catch(() =>
        codeToHtml(code, {
          lang: "text",
          themes: { light: "solarized-light", dark: "solarized-dark" },
          defaultColor: false,
        }),
      )
      .then((h) => live && setHtml(h));
    return () => {
      live = false;
    };
  }, [lang, code]);
  if (!html)
    return (
      <pre className="shiki-fallback">
        <code>{code}</code>
      </pre>
    );
  return <div className="not-prose shiki-block" dangerouslySetInnerHTML={{ __html: html }} />;
}

const components: Components = {
  pre: ({ children, node, ...rest }) => {
    const code = node?.children[0];
    if (code?.type === "element" && code.tagName === "code") {
      const cls = (code.properties.className as string[] | undefined) ?? [];
      const lang = cls.find((c) => c.startsWith("language-"))?.slice(9) ?? "";
      const text = code.children
        .map((c) => (c.type === "text" ? c.value : ""))
        .join("")
        .replace(/\n$/, "");
      return (
        <div
          data-code
          data-line={rest["data-line" as keyof typeof rest] as string}
          data-line-end={rest["data-line-end" as keyof typeof rest] as string}
        >
          <CodeBlock lang={lang} code={text} />
        </div>
      );
    }
    return <pre {...rest}>{children}</pre>;
  },
  a: DocLink,
  img: DocImage,
};

/** The open document's path, which relative links and images resolve against. */
const DocPath = createContext("");

/** A link in a document: in-page anchors scroll, workspace files open in the viewer. */
function DocLink({ node: _n, href = "", ...props }: React.ComponentProps<"a"> & { node?: unknown }) {
  const path = useContext(DocPath);
  if (isExternal(href)) return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
  const [rel, frag = ""] = href.split("#");
  // `#x` stays in this document; anything else is a file under the workspace.
  const target = rel ? resolveRel(path, rel) : path;
  return (
    <a
      {...props}
      href={hrefFor(target, frag)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(target, frag, { replace: target === path });
      }}
    />
  );
}

/** Images in a document are workspace files, read through /api/raw. */
function DocImage({ node: _n, src, ...props }: React.ComponentProps<"img"> & { node?: unknown }) {
  const path = useContext(DocPath);
  const url =
    typeof src === "string" && src && !isExternal(src) && !src.startsWith("data:")
      ? `${BASE}/api/raw?path=${encodeURIComponent(resolveRel(path, src))}`
      : src;
  return <img {...props} src={url} loading="lazy" />;
}

const Chunk = memo(function Chunk({ text, offset }: { text: string; offset: number }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSourceLines, { offset }]]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
});

type Draft = { line: number; quote: string };
type Heading = { id: string; text: string; level: number };

// The doc's 64rem column (max-w-5xl) plus the 14rem contents column (w-56): the
// contents take their own column only when the doc keeps its full width beside them.
const TOC_MIN_WIDTH = (64 + 14) * 16;

/** The document's h1–h3, linking each section and marking the one in view. */
function Contents({ toc, active, path, inRail }: { toc: Heading[]; active: string; path: string; inRail?: boolean }) {
  const top = Math.min(...toc.map((h) => h.level));
  const list = (
    <ul className="flex flex-col gap-0.5 border-l border-border">
      {toc.map((h) => (
        <li key={h.id}>
          <a
            href={hrefFor(path, h.id)}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate(path, h.id, { replace: true });
              document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            style={{ paddingLeft: `${0.75 + (h.level - top) * 0.75}rem` }}
            className={clsx(
              "-ml-px block truncate border-l py-0.5 pr-2 transition-colors",
              h.id === active
                ? "border-brand font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            title={h.text}
          >
            {h.text}
          </a>
        </li>
      ))}
    </ul>
  );
  const label = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";
  // Narrow: a collapsible block atop the comment rail, rather than squeezing the doc.
  if (inRail)
    return (
      <details open className="font-sans text-sm" aria-label="Contents">
        <summary className={clsx(label, "mb-2 cursor-pointer select-none")}>Contents</summary>
        <nav aria-label="Contents" className="max-h-64 overflow-y-auto">
          {list}
        </nav>
      </details>
    );
  return (
    <nav
      aria-label="Contents"
      className="sticky top-0 max-h-full w-56 shrink-0 self-start overflow-y-auto py-10 pl-6 font-sans text-sm"
    >
      <p className={clsx(label, "mb-2")}>Contents</p>
      {list}
    </nav>
  );
}
type Pop = { top: number; left: number; anchor: Draft };

// The server's cap on a quote; a longer block is quoted by its first line.
const MAX_QUOTE = 4000;

/** A paragraph comment's anchor: the block's line and its whole source text. */
function blockAnchor(body: string, el: HTMLElement): Draft {
  const start = Number(el.dataset.line);
  const end = Number(el.dataset.lineEnd ?? start);
  let quote = blockSource(body, start, end);
  if (new TextEncoder().encode(quote).length > MAX_QUOTE) quote = blockSource(body, start, start);
  return { line: start, quote };
}

/** A margin marker: the block's offset in the doc column and the threads on it. */
type Mark = { top: number; ids: string[]; open: number };
type Hover = { top: number; el: HTMLElement };

export function MarkdownPane({
  path,
  hash,
  body,
  threads,
  questions,
  onChange,
}: {
  path: string;
  hash: string;
  body: string;
  threads: Thread[];
  questions: Question[];
  onChange: () => void;
}) {
  const doc = useRef<HTMLDivElement>(null);
  // The doc column (article plus its margins), which the popover and markers sit in.
  const wrap = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [active, setActive] = useState<string | null>(null);
  // Picking a thread from the document (its highlight, its margin badge) also unfolds
  // it; a click inside its own card only selects it, or the card's Resolve and
  // Collapse would fold it and unfold it again in the same click. Counted, so picking
  // the same thread twice still unfolds it the second time.
  const [reveal, setReveal] = useState<{ id: string; n: number }>({ id: "", n: 0 });
  const pick = (id: string) => {
    setActive(id);
    setReveal((r) => ({ id, n: r.n + 1 }));
  };
  const ranges = useRef(new Map<string, Range>());
  // Threads on a whole block: no standing highlight (a margin marker shows them), and
  // a click in their text is an ordinary click, not a jump to the thread.
  const whole = useRef(new Set<string>());
  const [marks, setMarks] = useState<Mark[]>([]);
  const [hover, setHover] = useState<Hover | null>(null);
  const segs = useMemo(() => segments(body), [body]);
  // By id, not line: an agent's edit above a block moves its line but not its id.
  const qById = useMemo(() => new Map(questions.map((q) => [q.id, q])), [questions]);
  const [toc, setToc] = useState<Heading[]>([]);

  // Heading ids, set on the DOM across every chunk so two "Design" sections get
  // design and design-2, then the address's #heading is scrolled to.
  useLayoutEffect(() => {
    const root = doc.current;
    if (!root) return;
    const seen = new Map<string, number>();
    root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((h) => {
      const base = slug(h.textContent ?? "");
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      h.id = n > 1 ? `${base}-${n}` : base;
    });
    const found = [...root.querySelectorAll<HTMLElement>("h1, h2, h3")].map((h) => ({
      id: h.id,
      text: h.textContent ?? "",
      level: Number(h.tagName[1]),
    }));
    setToc((old) => (JSON.stringify(old) === JSON.stringify(found) ? old : found));
  }, [segs]);
  // Once per address, so an auto-refresh of the body never yanks the reader back.
  const scrolledTo = useRef("");
  useEffect(() => {
    const key = `${path}#${hash}`;
    if (!hash || scrolledTo.current === key) return;
    const el = document.getElementById(hash);
    if (!el) return;
    scrolledTo.current = key;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [path, hash, segs]);

  // Paint each thread's quote with the CSS Custom Highlight API, so React's DOM is
  // untouched, and place a marker in the margin beside each commented block.
  useLayoutEffect(() => {
    const root = doc.current;
    const col = wrap.current;
    if (!root || !col) return;
    const paint = () => {
      ranges.current.clear();
      whole.current.clear();
      const open: Range[] = [];
      const done: Range[] = [];
      const top = col.getBoundingClientRect().top;
      const byBlock = new Map<HTMLElement, Mark>();
      const rangeOf = (line: number, quote: string) => {
        const block = blockAt(root, line);
        const q = plainOf(quote);
        const all = !q || (!!block && plainOf(blockAnchor(body, block).quote) === q);
        let r = q && !all ? (block && findText(block, q)) || findText(root, q) : null;
        if (!r && block) {
          r = document.createRange();
          r.selectNodeContents(block);
        }
        return { block, r, all: all || !q };
      };
      for (const t of threads) {
        if (t.stale) continue;
        const { block, r, all } = rangeOf(t.line, t.quote);
        if (!r) continue;
        ranges.current.set(t.id, r);
        if (all) whole.current.add(t.id);
        else (t.resolved ? done : open).push(r);
        if (block) {
          const m = byBlock.get(block) ?? { top: block.getBoundingClientRect().top - top, ids: [], open: 0 };
          m.ids.push(t.id);
          if (!t.resolved) m.open++;
          byBlock.set(block, m);
        }
      }
      const next = [...byBlock.values()];
      setMarks((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
      if (!("highlights" in CSS)) return;
      CSS.highlights.set("comment", new Highlight(...open));
      CSS.highlights.set("comment-resolved", new Highlight(...done));
      // The thread in focus, or the passage a new comment is being written on.
      const a = (active && ranges.current.get(active)) || (draft && rangeOf(draft.line, draft.quote).r);
      if (a) CSS.highlights.set("comment-active", new Highlight(a));
      else CSS.highlights.delete("comment-active");
    };
    paint();
    // Code blocks highlight asynchronously and replace their text nodes; repaint then,
    // and when the column reflows, since the markers follow their blocks.
    const mo = new MutationObserver(paint);
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(paint);
    ro.observe(root);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [threads, active, body, draft]);

  // Pick the block by the pointer's height, not by e.target: the margin the button sits
  // in, and the gaps between blocks, are inside no block.
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-gutter]")) return;
    const root = doc.current;
    const col = wrap.current;
    if (!root || !col) return;
    const y = e.clientY;
    let best: HTMLElement | null = null;
    let bestH = Infinity;
    for (const el of root.querySelectorAll<HTMLElement>(BLOCKS)) {
      if (el.closest("[data-question]")) continue;
      const r = el.getBoundingClientRect();
      // The innermost block on this row: a loose list item's paragraph, not the item.
      if (y >= r.top && y <= r.bottom && r.height < bestH) {
        best = el;
        bestH = r.height;
      }
    }
    // In a gap between blocks, keep the last one so the button doesn't flicker.
    if (!best) return;
    const top = best.getBoundingClientRect().top - col.getBoundingClientRect().top;
    setHover((h) => (h?.el === best && h.top === top ? h : { el: best, top }));
  }, []);

  const onMouseUp = useCallback(() => {
    const sel = window.getSelection();
    const root = doc.current;
    const col = wrap.current;
    if (!sel || sel.isCollapsed || !root || !col || !root.contains(sel.anchorNode)) return setPop(null);
    const range = sel.getRangeAt(0);
    const start = range.startContainer;
    const el = (start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement) as HTMLElement | null;
    const block = el?.closest<HTMLElement>("[data-line]");
    if (!block) return setPop(null);
    const anchor = sourceAnchor(body, Number(block.dataset.line), sel.toString());
    const rect = range.getBoundingClientRect();
    // Measured against the column the popover is placed in, not the article inside it.
    const box = col.getBoundingClientRect();
    setPop({ top: rect.top - box.top - 40, left: rect.left - box.left + rect.width / 2, anchor });
  }, [body]);

  const commentOnBlock = (el: HTMLElement) => {
    setActive(null);
    setPop(null);
    window.getSelection()?.removeAllRanges();
    setDraft(blockAnchor(body, el));
  };

  // A click inside a highlighted quote opens its thread.
  const onClick = useCallback((e: React.MouseEvent) => {
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    if (!pos) return;
    for (const [id, r] of ranges.current)
      if (!whole.current.has(id) && r.isPointInRange(pos.offsetNode, pos.offset)) {
        pick(id);
        document.getElementById(`thread-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
  }, []);

  const focusThread = (t: Thread) => {
    setActive(t.id);
    const r = ranges.current.get(t.id);
    const target = r?.startContainer.parentElement ?? (doc.current && blockAt(doc.current, t.line));
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const openThreads = threads.filter((t) => !t.resolved);

  // Contents sit beside the doc only when there is room; the tree and rail both take width.
  const scroller = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= TOC_MIN_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The section being read: the last heading scrolled past the top.
  const [current, setCurrent] = useState("");
  useEffect(() => {
    const el = scroller.current;
    if (!el || toc.length < 2) return;
    const onScroll = () => {
      const top = el.getBoundingClientRect().top + 24;
      let at = toc[0].id;
      for (const h of toc) {
        const node = document.getElementById(h.id);
        if (node && node.getBoundingClientRect().top <= top) at = h.id;
      }
      setCurrent(at);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [toc]);

  return (
    <div className="flex min-h-0 flex-1">
      <div ref={scroller} className="flex min-w-0 flex-1 overflow-y-auto">
        {wide && toc.length > 1 && <Contents toc={toc} active={current} path={path} />}
        <div
          ref={wrap}
          className="relative mx-auto min-w-0 max-w-5xl flex-1 self-start px-8 py-10"
          onMouseUp={onMouseUp}
          onClick={onClick}
          onMouseMove={onMouseMove}
          onMouseLeave={() => setHover(null)}
        >
          <DocPath.Provider value={path}>
            <article
              ref={doc}
              className="prose prose-stone dark:prose-invert max-w-none prose-headings:scroll-mt-4 prose-pre:p-0"
            >
              {segs.map((s, i) => {
                const q = s.kind === "question" ? qById.get(s.id) : undefined;
                if (s.kind === "question" && q)
                  return (
                    <div key={`q:${s.id}`} data-line={s.line} className="not-prose my-6">
                      <QuestionCard path={path} question={q} onChange={onChange} />
                    </div>
                  );
                return <Chunk key={i} text={s.text} offset={s.offset} />;
              })}
            </article>
          </DocPath.Provider>
          {pop && (
            <button
              className="btn-primary absolute z-10 -translate-x-1/2 shadow-lg"
              style={{ top: pop.top, left: pop.left }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setDraft(pop.anchor);
                setPop(null);
              }}
            >
              <MessageSquarePlus className="size-3.5" /> Comment
            </button>
          )}
          {hover && (
            <button
              data-gutter
              aria-label="Comment on this paragraph"
              title="Comment on this paragraph"
              className="absolute left-1 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-brand"
              style={{ top: hover.top }}
              onMouseDown={(e) => e.preventDefault()}
              onMouseUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                commentOnBlock(hover.el);
              }}
            >
              <MessageSquarePlus className="size-4" />
            </button>
          )}
          {marks.map((m) => {
            const on = !!active && m.ids.includes(active);
            const n = m.open || m.ids.length;
            return (
              <button
                key={m.ids[0]}
                data-gutter
                data-mark
                aria-label={`${n} ${m.open ? "open " : "resolved "}comment${n === 1 ? "" : "s"}`}
                title={`${n} ${m.open ? "open" : "resolved"} comment${n === 1 ? "" : "s"}`}
                className={clsx(
                  "absolute right-1 flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full px-1.5 font-sans text-[11px] font-semibold transition-colors",
                  on
                    ? "bg-brand text-brand-foreground"
                    : m.open
                      ? "bg-warning/15 text-warning hover:bg-warning/25"
                      : "bg-muted text-muted-foreground hover:bg-accent",
                )}
                style={{ top: m.top }}
                onMouseUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const t = threads.find((x) => m.ids.includes(x.id) && !x.resolved) ?? threads.find((x) => x.id === m.ids[0]);
                  if (!t) return;
                  pick(t.id);
                  document.getElementById(`thread-${t.id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                }}
              >
                <MessageSquare className="size-3" />
                {n > 1 && n}
              </button>
            );
          })}
        </div>
      </div>

      <aside
        data-comments
        className="flex w-[22rem] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-sidebar/50 p-4"
      >
        {!wide && toc.length > 1 && <Contents toc={toc} active={current} path={path} inRail />}
        <h2 className="flex items-center gap-2 font-sans text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Comments
          {openThreads.length > 0 && (
            <span className="pill bg-warning/15 normal-case tracking-normal text-warning">
              {openThreads.length} open
            </span>
          )}
          {threads.length > openThreads.length && (
            <span className="ml-auto font-normal normal-case tracking-normal">
              {threads.length - openThreads.length} resolved
            </span>
          )}
        </h2>
        {draft && (
          <div className="rounded-lg border border-brand bg-card p-3 font-sans text-sm shadow-sm ring-2 ring-brand/30">
            {draft.quote && <Quote text={previewOf(draft.quote)} className="mb-3" />}
            <Composer
              autoFocus
              placeholder="Leave a comment for the agent…"
              submitLabel="Comment"
              onCancel={() => setDraft(null)}
              onSubmit={async (text) => {
                await api.add({ path, line: draft.line, quote: draft.quote, text });
                setDraft(null);
                window.getSelection()?.removeAllRanges();
                onChange();
              }}
            />
          </div>
        )}
        {!draft && !threads.length && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center font-sans text-sm text-muted-foreground">
            <MessageSquarePlus className="size-5 opacity-60" />
            Hover a paragraph and click the comment icon in its margin, or select a passage to comment on just that.
          </div>
        )}
        {threads.map((t) => (
          <div key={t.id} id={`thread-${t.id}`} onClick={() => focusThread(t)}>
            <ThreadCard thread={t} path={path} onChange={onChange} showQuote active={active === t.id} reveal={reveal.id === t.id ? reveal.n : 0} />
          </div>
        ))}
      </aside>
    </div>
  );
}
