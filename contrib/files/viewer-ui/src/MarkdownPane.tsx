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
import { MessageSquarePlus } from "lucide-react";
import clsx from "clsx";
import { api, BASE, type Question, type Thread } from "./api";
import { hrefFor, isExternal, navigate, resolveRel, slug } from "./nav";
import { findText, rehypeSourceLines, segments, sourceAnchor } from "./markdown";
import { Composer, ThreadCard } from "./Thread";
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
        <div data-line={rest["data-line" as keyof typeof rest] as string}>
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

// The doc's 48rem column plus a 14rem contents column.
const TOC_MIN_WIDTH = 1000;

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

/** The element tagged with `line`, or the nearest tagged block before it. */
function blockFor(root: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLine = -1;
  root.querySelectorAll<HTMLElement>("[data-line]").forEach((el) => {
    const l = Number(el.dataset.line);
    if (l <= line && l > bestLine) {
      best = el;
      bestLine = l;
    }
  });
  return best;
}

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
  const [pop, setPop] = useState<Pop | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const ranges = useRef(new Map<string, Range>());
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

  // Paint each thread's quote with the CSS Custom Highlight API, so React's DOM is untouched.
  useLayoutEffect(() => {
    const root = doc.current;
    if (!root || !("highlights" in CSS)) return;
    const paint = () => {
      ranges.current.clear();
      const open: Range[] = [];
      const done: Range[] = [];
      for (const t of threads) {
        if (t.stale) continue;
        const block = blockFor(root, t.line);
        const q = t.quote.split("\n")[0];
        let r = q ? (block && findText(block, q)) || findText(root, q) : null;
        if (!r && block) {
          r = document.createRange();
          r.selectNodeContents(block);
        }
        if (!r) continue;
        ranges.current.set(t.id, r);
        (t.resolved ? done : open).push(r);
      }
      CSS.highlights.set("comment", new Highlight(...open));
      CSS.highlights.set("comment-resolved", new Highlight(...done));
      const a = active && ranges.current.get(active);
      if (a) CSS.highlights.set("comment-active", new Highlight(a));
      else CSS.highlights.delete("comment-active");
    };
    paint();
    // Code blocks highlight asynchronously and replace their text nodes; repaint then.
    const mo = new MutationObserver(paint);
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [threads, active, body]);

  const onMouseUp = useCallback(() => {
    const sel = window.getSelection();
    const root = doc.current;
    if (!sel || sel.isCollapsed || !root || !root.contains(sel.anchorNode)) return setPop(null);
    const range = sel.getRangeAt(0);
    const start = range.startContainer;
    const el = (start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement) as HTMLElement | null;
    const block = el?.closest<HTMLElement>("[data-line]");
    if (!block) return setPop(null);
    const anchor = sourceAnchor(body, Number(block.dataset.line), sel.toString());
    const rect = range.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    setPop({ top: rect.top - box.top - 40, left: rect.left - box.left + rect.width / 2, anchor });
  }, [body]);

  // A click inside a highlighted quote opens its thread.
  const onClick = useCallback((e: React.MouseEvent) => {
    const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
    if (!pos) return;
    for (const [id, r] of ranges.current)
      if (r.isPointInRange(pos.offsetNode, pos.offset)) {
        setActive(id);
        document.getElementById(`thread-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
  }, []);

  const focusThread = (t: Thread) => {
    setActive(t.id);
    const r = ranges.current.get(t.id);
    const target = r?.startContainer.parentElement ?? (doc.current && blockFor(doc.current, t.line));
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
        <div className="relative mx-auto min-w-0 max-w-3xl flex-1 px-10 py-10" onMouseUp={onMouseUp} onClick={onClick}>
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
        </div>
      </div>

      <aside
        data-comments
        className="flex w-[22rem] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-sidebar/50 p-4"
      >
        {!wide && toc.length > 1 && <Contents toc={toc} active={current} path={path} inRail />}
        <h2 className="flex items-center justify-between font-sans text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Comments
          <span className="font-normal normal-case tracking-normal">
            {openThreads.length} open
            {threads.length > openThreads.length ? ` · ${threads.length - openThreads.length} resolved` : ""}
          </span>
        </h2>
        {draft && (
          <div className="rounded-lg border border-brand bg-card p-3 font-sans text-sm shadow-sm ring-2 ring-brand/30">
            {draft.quote && (
              <blockquote className="mb-2 line-clamp-3 text-xs italic text-muted-foreground">
                “{draft.quote}”
              </blockquote>
            )}
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
          <p className="font-sans text-sm text-muted-foreground">Select any text in the document to comment on it.</p>
        )}
        {threads.map((t) => (
          <div key={t.id} id={`thread-${t.id}`} onClick={() => focusThread(t)}>
            <ThreadCard thread={t} path={path} onChange={onChange} showQuote active={active === t.id} />
          </div>
        ))}
      </aside>
    </div>
  );
}
