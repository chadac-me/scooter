import { useEffect, useState } from "react";
import { ChevronRight, File as FileIcon, FileCode2, FileText, Folder, FolderGit2, FolderOpen } from "lucide-react";
import clsx from "clsx";
import { api, type Entry } from "./api";

const cache = new Map<string, Promise<Entry[]>>();
const load = (dir: string) => {
  if (!cache.has(dir)) cache.set(dir, api.list(dir).then((l) => l.entries).catch(() => []));
  return cache.get(dir)!;
};

const CODE = /\.(ts|tsx|js|mjs|jsx|py|nix|rs|go|sh|json|ya?ml|toml|css|html|sql|lua|rb|java|c|h|cpp|hs)$/;

function icon(e: Entry, open: boolean) {
  if (e.kind === "dir") {
    if (e.repo) return <FolderGit2 className="size-4 shrink-0 text-chart-5" />;
    return open ? <FolderOpen className="size-4 shrink-0 text-brand" /> : <Folder className="size-4 shrink-0 text-brand" />;
  }
  if (/\.(md|markdown)$/.test(e.name)) return <FileText className="size-4 shrink-0 text-chart-2" />;
  if (CODE.test(e.name)) return <FileCode2 className="size-4 shrink-0 text-muted-foreground" />;
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
}

function Node({
  entry,
  path,
  depth,
  selected,
  onSelect,
}: {
  entry: Entry;
  path: string;
  depth: number;
  selected: string;
  onSelect: (p: string) => void;
}) {
  const isDir = entry.kind === "dir";
  const [open, setOpen] = useState(isDir && selected.startsWith(path + "/"));
  const active = selected === path;
  return (
    <li>
      <button
        title={path}
        onClick={() => (isDir ? setOpen(!open) : onSelect(path))}
        className={clsx(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] leading-5 transition-colors",
          active ? "bg-accent font-medium text-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60",
          entry.skip && "opacity-50",
        )}
        style={{ paddingLeft: depth * 12 + 6 }}
      >
        <ChevronRight
          className={clsx("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", !isDir && "invisible")}
        />
        {icon(entry, open)}
        <span className="truncate">{entry.name}</span>
      </button>
      {isDir && open && <Children dir={path} depth={depth + 1} selected={selected} onSelect={onSelect} />}
    </li>
  );
}

function Children({ dir, depth, selected, onSelect }: { dir: string; depth: number; selected: string; onSelect: (p: string) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  useEffect(() => {
    load(dir).then(setEntries);
  }, [dir]);
  if (!entries) return <div className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: depth * 12 + 26 }}>…</div>;
  return (
    <ul>
      {entries.map((e) => (
        <Node key={e.name} entry={e} path={dir ? `${dir}/${e.name}` : e.name} depth={depth} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}

export function Tree({ selected, onSelect }: { selected: string; onSelect: (p: string) => void }) {
  return (
    <nav className="font-sans">
      <Children dir="" depth={0} selected={selected} onSelect={onSelect} />
    </nav>
  );
}
