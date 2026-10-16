import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";
import { MessageSquarePlus } from "lucide-react";
import { api, type Question, type Thread } from "./api";
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
        codeToHtml(code, { lang: "text", themes: { light: "solarized-light", dark: "solarized-dark" }, defaultColor: false }),
      )
      .then((h) => live && setHtml(h));
    return () => {
      live = false;
    };
  }, [lang, code]);
  if (!html) return <pre className="shiki-fallback"><code>{code}</code></pre>;
  return <div className="not-prose shiki-block" dangerouslySetInnerHTML={{ __html: html }} />;
}

const components: Components = {
  pre: ({ children, node, ...rest }) => {
    const code = node?.children[0];
    if (code?.type === "element" && code.tagName === "code") {
      const cls = (code.properties.className as string[] | undefined) ?? [];
      const lang = cls.find((c) => c.startsWith("language-"))?.slice(9) ?? "";
      const text = code.children.map((c) => (c.type === "text" ? c.value : "")).join("").replace(/\n$/, "");
      return (
        <div data-line={rest["data-line" as keyof typeof rest] as string}>
          <CodeBlock lang={lang} code={text} />
        </div>
      );
    }
    return <pre {...rest}>{children}</pre>;
  },
  a: ({ node: _n, ...props }) => <a {...props} target={props.href?.startsWith("#") ? undefined : "_blank"} rel="noreferrer" />,
};

const Chunk = memo(function Chunk({ text, offset }: { text: string; offset: number }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSourceLines, { offset }]]} components={components}>
      {text}
    </ReactMarkdown>
  );
});

type Draft = { line: number; quote: string };
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
  body,
  threads,
  questions,
  onChange,
}: {
  path: string;
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
  const qByLine = useMemo(() => new Map(questions.map((q) => [q.line, q])), [questions]);

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

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="relative mx-auto max-w-3xl px-10 py-10" onMouseUp={onMouseUp} onClick={onClick}>
          <article ref={doc} className="prose prose-stone dark:prose-invert max-w-none prose-headings:scroll-mt-4 prose-pre:p-0">
            {segs.map((s, i) => {
              const q = s.kind === "question" ? qByLine.get(s.line) : undefined;
              if (s.kind === "question" && q)
                return (
                  <div key={i} data-line={s.line} className="not-prose my-6">
                    <QuestionCard path={path} question={q} onChange={onChange} />
                  </div>
                );
              return <Chunk key={i} text={s.text} offset={s.offset} />;
            })}
          </article>
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

      <aside className="flex w-[22rem] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-sidebar/50 p-4">
        <h2 className="flex items-center justify-between font-sans text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Comments
          <span className="font-normal normal-case tracking-normal">
            {openThreads.length} open{threads.length > openThreads.length ? ` · ${threads.length - openThreads.length} resolved` : ""}
          </span>
        </h2>
        {draft && (
          <div className="rounded-lg border border-brand bg-card p-3 font-sans text-sm shadow-sm ring-2 ring-brand/30">
            {draft.quote && <blockquote className="mb-2 line-clamp-3 text-xs italic text-muted-foreground">“{draft.quote}”</blockquote>}
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
