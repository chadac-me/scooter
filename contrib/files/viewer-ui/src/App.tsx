import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Code2, Eye, FileSearch, Moon, PanelLeft, RefreshCw, Sun } from "lucide-react";
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

/** A doc's first `# ` heading, outside code fences. */
function mdTitle(body: string): string {
  let fence = "";
  for (const line of body.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = "";
      continue;
    }
    if (fence) continue;
    const h = /^\s{0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h)
      return h[1]
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[`*_~]/g, "")
        .trim();
  }
  return "";
}

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

  const [live, toggleLive] = useLive();

  // Pending comments flip to delivered once the broker acks. Live, the ack arrives as
  // an event; otherwise poll fast while any are pending.
  useEffect(() => {
    if (!path || live || !annotations.some((a) => a.state === "pending")) return;
    const t = setTimeout(() => load(path).catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [annotations, path, load, live]);

  // Live: the server pushes an event when the file or its notes change, and the page
  // refetches through the ordinary routes (the file costs nothing if it is unchanged).
  useEffect(() => {
    if (!path || !live) return;
    // One load at a time; events that land mid-load fold into one more.
    let busy = false;
    let again = false;
    const refetch = async () => {
      if (busy) return void (again = true);
      busy = true;
      do {
        again = false;
        await load(path).catch(() => {});
      } while (again);
      busy = false;
    };
    let opened = false;
    const es = api.events(path);
    // EventSource reconnects by itself; anything missed while it was down is picked
    // up by refetching on every reopen after the first.
    es.onopen = () => {
      if (opened) refetch();
      opened = true;
    };
    es.addEventListener("file", refetch);
    es.addEventListener("notes", refetch);
    return () => es.close();
  }, [path, live, load]);

  const threads = useMemo(() => threadsOf(annotations), [annotations]);
  const refresh = () => {
    load(path).catch(() => {});
  };
  const md = file?.renderer === "markdown";
  const open = threads.filter((t) => !t.resolved).length;
  const unanswered = questions.filter((q) => !q.answered).length;

  // Tab title: the doc's heading, else the filename.
  const shownFile = file && file.path === path ? file : null;
  const docTitle = useMemo(() => (shownFile?.renderer === "markdown" ? mdTitle(shownFile.body) : ""), [shownFile]);
  useEffect(() => {
    const name = path.split("/").pop() || "";
    const label = docTitle || name;
    document.title = label ? `${label} · Files` : "Files";
  }, [path, docTitle]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-header px-3 font-sans text-sm">
        <button className="icon-btn" onClick={() => setTree(!tree)} title="Toggle file tree">
          <PanelLeft className="size-4" />
        </button>
        <nav aria-label="Path" className="flex min-w-0 items-center gap-0.5 text-muted-foreground">
          {(path ? path.split("/") : ["Files"]).map((part, i, all) => (
            <span key={i} className={clsx("flex items-center gap-0.5", i === all.length - 1 ? "min-w-0" : "shrink-0")}>
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 opacity-50" />}
              <span className={clsx("truncate", i === all.length - 1 && "font-medium text-foreground")}>{part}</span>
            </span>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {unanswered > 0 && (
            <span className="pill bg-brand/15 text-brand">
              {unanswered} question{unanswered > 1 ? "s" : ""}
            </span>
          )}
          {/* The preview's rail shows its own count. */}
          {open > 0 && !(md && !source) && (
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
          <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
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
            <div className="m-auto flex flex-col items-center gap-2 font-sans text-sm text-muted-foreground">
              <FileSearch className="size-8 opacity-40" />
              Pick a file from the tree.
            </div>
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
