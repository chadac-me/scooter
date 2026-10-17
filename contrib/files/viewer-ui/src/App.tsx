import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Code2, Eye, Moon, PanelLeft, RefreshCw, Sun } from "lucide-react";
import clsx from "clsx";
import { api, threadsOf, type Annotation, type FileView, type Question } from "./api";
import { Tree } from "./Tree";
import { CodePane } from "./CodePane";
import { MarkdownPane } from "./MarkdownPane";
import { RetryAll } from "./Thread";
import { current, navigate, onNavigate } from "./nav";

function useDark() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("files-theme");
    return saved ? saved === "dark" : media.matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const toggle = () =>
    setDark((d) => {
      localStorage.setItem("files-theme", d ? "light" : "dark");
      return !d;
    });
  return [dark, toggle] as const;
}

const POLL_MS = 3000;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function useLive() {
  const [live, setLive] = useState(() => localStorage.getItem("files-live") !== "off");
  const toggle = () =>
    setLive((l) => {
      localStorage.setItem("files-live", l ? "off" : "on");
      return !l;
    });
  return [live, toggle] as const;
}

export function App() {
  const [{ path, hash }, setLoc] = useState(current);
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState("");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [source, setSource] = useState(false);
  const [tree, setTree] = useState(true);
  const [dark, toggleDark] = useDark();

  useEffect(() => {
    // Rewrite an old-style `#/<file>` link to the canonical address once.
    if (path && !new URLSearchParams(location.search).has("path")) navigate(path, hash, { replace: true });
    return onNavigate(() => setLoc(current()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The open file's etag, so a poll asks only whether it changed.
  const etag = useRef("");
  const shown = useRef(path);
  shown.current = path;

  /** Body, comments and questions together, so question lines always index the body shown. */
  const load = useCallback(async (p: string, fresh = false) => {
    const [f, a, q] = await Promise.all([
      fresh || !etag.current ? api.file(p) : api.fileIfChanged(p, etag.current),
      api.annotations(p).catch(() => [] as Annotation[]),
      api.questions(p).catch(() => ({ questions: [] as Question[], etag: "" })),
    ]);
    // The file moved between the two reads; fetch it again rather than misplace questions.
    let next = f;
    const have = next?.etag ?? etag.current;
    if (q.etag && have && q.etag !== have) next = await api.file(p);
    if (shown.current !== p) return;
    if (next) {
      etag.current = next.etag ?? "";
      setFile(next);
    }
    setAnnotations((old) => (same(old, a) ? old : a));
    setQuestions((old) => (same(old, q.questions) ? old : q.questions));
  }, []);

  useEffect(() => {
    if (!path) return;
    setError("");
    etag.current = "";
    load(path, true).catch((e) => {
      setFile(null);
      setError(String(e.message ?? e));
    });
  }, [path, load]);

  // Pending comments flip to delivered once the broker acks; poll fast while any are pending.
  useEffect(() => {
    if (!path || !annotations.some((a) => a.state === "pending")) return;
    const t = setTimeout(() => load(path).catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [annotations, path, load]);

  // Auto-refresh: pick up the agent's edits and replies while the tab is visible.
  const [live, toggleLive] = useLive();
  useEffect(() => {
    if (!path || !live) return;
    const tick = () => {
      if (document.visibilityState === "visible") load(path).catch(() => {});
    };
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [path, live, load]);

  const threads = useMemo(() => threadsOf(annotations), [annotations]);
  const refresh = () => {
    load(path).catch(() => {});
  };
  const md = file?.renderer === "markdown";
  const open = threads.filter((t) => !t.resolved).length;
  const unanswered = questions.filter((q) => !q.answered).length;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-header px-3 font-sans text-sm">
        <button className="icon-btn" onClick={() => setTree(!tree)} title="Toggle file tree">
          <PanelLeft className="size-4" />
        </button>
        <nav className="flex min-w-0 items-center gap-1 truncate text-muted-foreground">
          {(path || "Files").split("/").map((part, i, all) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="opacity-50">/</span>}
              <span className={clsx(i === all.length - 1 && "font-medium text-foreground")}>{part}</span>
            </span>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {unanswered > 0 && (
            <span className="pill bg-brand/15 text-brand">
              {unanswered} question{unanswered > 1 ? "s" : ""}
            </span>
          )}
          {open > 0 && (
            <span className="pill bg-warning/15 text-warning">
              {open} open comment{open > 1 ? "s" : ""}
            </span>
          )}
          <RetryAll failed={annotations.filter((a) => a.state === "failed")} onChange={refresh} />
          {md && (
            <div className="flex rounded-md border border-border p-0.5">
              <button className={clsx("seg", !source && "seg-on")} onClick={() => setSource(false)}>
                <Eye className="size-3.5" /> Preview
              </button>
              <button className={clsx("seg", source && "seg-on")} onClick={() => setSource(true)}>
                <Code2 className="size-3.5" /> Source
              </button>
            </div>
          )}
          <button
            className={clsx("icon-btn", live && "text-brand")}
            onClick={toggleLive}
            title={live ? "Auto-refresh on: click to pause" : "Auto-refresh paused: click to resume"}
            aria-pressed={live}
          >
            <RefreshCw className="size-4" />
          </button>
          <button className="icon-btn" onClick={toggleDark} title="Toggle theme">
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {tree && (
          <aside className="w-64 shrink-0 overflow-y-auto border-r border-border bg-sidebar p-2">
            <Tree selected={path} onSelect={(p) => navigate(p)} />
          </aside>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          {error && <p className="m-6 font-sans text-sm text-destructive">{error}</p>}
          {!path && !error && (
            <div className="m-auto font-sans text-sm text-muted-foreground">Pick a file from the tree.</div>
          )}
          {file && file.path === path && (file.renderer === "binary" || file.renderer === "too-large") && (
            <div className="m-auto font-sans text-sm text-muted-foreground">
              {file.renderer === "binary" ? "Binary file, not shown." : "Too large to show."}
            </div>
          )}
          {file && file.path === path && md && !source && (
            <MarkdownPane
              path={path}
              hash={hash}
              body={file.body}
              threads={threads}
              questions={questions}
              onChange={refresh}
            />
          )}
          {file && file.path === path && (file.renderer === "code" || (md && source)) && (
            <div className="min-h-0 flex-1 overflow-auto">
              <CodePane path={path} body={file.body} threads={threads} dark={dark} onChange={refresh} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
