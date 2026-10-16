import { useCallback, useEffect, useMemo, useState } from "react";
import { Code2, Eye, Moon, PanelLeft, Sun } from "lucide-react";
import clsx from "clsx";
import { api, threadsOf, type Annotation, type FileView, type Question } from "./api";
import { Tree } from "./Tree";
import { CodePane } from "./CodePane";
import { MarkdownPane } from "./MarkdownPane";
import { RetryAll } from "./Thread";

const pathFromHash = () => decodeURIComponent(location.hash.replace(/^#\/?/, ""));

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

export function App() {
  const [path, setPath] = useState(pathFromHash);
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState("");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [source, setSource] = useState(false);
  const [tree, setTree] = useState(true);
  const [dark, toggleDark] = useDark();

  useEffect(() => {
    const on = () => setPath(pathFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const loadNotes = useCallback(async (p: string) => {
    const [a, q] = await Promise.all([api.annotations(p).catch(() => []), api.questions(p).catch(() => [])]);
    setAnnotations(a);
    setQuestions(q);
  }, []);

  useEffect(() => {
    if (!path) return;
    setError("");
    api
      .file(path)
      .then((f) => {
        setFile(f);
        return loadNotes(path);
      })
      .catch((e) => {
        setFile(null);
        setError(String(e.message ?? e));
      });
  }, [path, loadNotes]);

  // Pending comments flip to delivered once the broker acks; poll only while any are pending.
  useEffect(() => {
    if (!path || !annotations.some((a) => a.state === "pending")) return;
    const t = setTimeout(() => loadNotes(path), 1500);
    return () => clearTimeout(t);
  }, [annotations, path, loadNotes]);

  const threads = useMemo(() => threadsOf(annotations), [annotations]);
  const refresh = () => loadNotes(path);
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
          {unanswered > 0 && <span className="pill bg-brand/15 text-brand">{unanswered} question{unanswered > 1 ? "s" : ""}</span>}
          {open > 0 && <span className="pill bg-warning/15 text-warning">{open} open comment{open > 1 ? "s" : ""}</span>}
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
          <button className="icon-btn" onClick={toggleDark} title="Toggle theme">
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {tree && (
          <aside className="w-64 shrink-0 overflow-y-auto border-r border-border bg-sidebar p-2">
            <Tree selected={path} onSelect={(p) => (location.hash = `/${p}`)} />
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
            <MarkdownPane path={path} body={file.body} threads={threads} questions={questions} onChange={refresh} />
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
