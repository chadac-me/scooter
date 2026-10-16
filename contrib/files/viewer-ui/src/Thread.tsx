import { useState } from "react";
import { Check, CircleAlert, Loader2, MessageSquare, RotateCcw, Undo2 } from "lucide-react";
import clsx from "clsx";
import { api, type Annotation, type Thread } from "./api";

function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function SyncBadge({ a, onChange }: { a: Annotation; onChange: () => void }) {
  if (a.state === "pending")
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Not yet delivered to the agent">
        <Loader2 className="size-3 animate-spin" /> sending
      </span>
    );
  if (a.state === "failed")
    return (
      <button
        className="inline-flex items-center gap-1 text-xs text-destructive hover:underline"
        title={a.error}
        onClick={() => api.retry(a.id).then(onChange)}
      >
        <CircleAlert className="size-3" /> not delivered, retry
      </button>
    );
  return null;
}

export function Composer({
  placeholder,
  submitLabel,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  onSubmit: (text: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(text);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === "Escape") onCancel?.();
        }}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-sans text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/60"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">⌘/Ctrl + Enter</span>
        {onCancel && (
          <button className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn-primary" disabled={!text.trim() || busy} onClick={submit}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

export function ThreadCard({
  thread,
  path,
  onChange,
  showQuote,
  active,
}: {
  thread: Thread;
  path: string;
  onChange: () => void;
  showQuote?: boolean;
  active?: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const [open, setOpen] = useState(!thread.resolved);

  if (!open)
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-left font-sans text-xs text-muted-foreground hover:bg-accent"
      >
        <Check className="size-3.5 text-success" />
        Resolved · {thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}
        <span className="truncate">: {thread.comments[0].text}</span>
      </button>
    );

  return (
    <div
      className={clsx(
        "rounded-lg border bg-card font-sans text-sm text-card-foreground shadow-sm transition-shadow",
        active ? "border-brand ring-2 ring-brand/30" : "border-border",
      )}
    >
      {showQuote && thread.quote && (
        <blockquote className="line-clamp-2 border-b border-border px-3 py-2 text-xs italic text-muted-foreground">
          “{thread.quote}”
        </blockquote>
      )}
      {thread.stale && (
        <p className="flex items-center gap-1.5 border-b border-border bg-warning/10 px-3 py-1.5 text-xs text-warning">
          <CircleAlert className="size-3.5" /> The quoted text has changed since this was written.
        </p>
      )}
      <ul className="divide-y divide-border">
        {thread.comments.map((c) => (
          <li key={c.id} className="px-3 py-2.5">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">You</span>
              <span>{ago(c.created_at)}</span>
              <span className="ml-auto">
                <SyncBadge a={c} onChange={onChange} />
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words leading-relaxed">{c.text}</p>
          </li>
        ))}
      </ul>
      <div className="border-t border-border px-3 py-2">
        {replying ? (
          <Composer
            autoFocus
            placeholder="Reply…"
            submitLabel="Reply"
            onCancel={() => setReplying(false)}
            onSubmit={async (text) => {
              await api.add({ path, line: thread.line, quote: thread.quote, text, thread: thread.id });
              setReplying(false);
              onChange();
            }}
          />
        ) : (
          <div className="flex items-center gap-1">
            <button className="btn-ghost" onClick={() => setReplying(true)}>
              <MessageSquare className="size-3.5" /> Reply
            </button>
            <button
              className="btn-ghost ml-auto"
              onClick={() =>
                api.resolve(thread.id, !thread.resolved).then(() => {
                  setOpen(thread.resolved);
                  onChange();
                })
              }
            >
              {thread.resolved ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
              {thread.resolved ? "Reopen" : "Resolve"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function RetryAll({ failed, onChange }: { failed: Annotation[]; onChange: () => void }) {
  if (!failed.length) return null;
  return (
    <button
      className="btn-ghost text-destructive"
      onClick={() => Promise.all(failed.map((a) => api.retry(a.id))).then(onChange)}
    >
      <RotateCcw className="size-3.5" /> Retry {failed.length} undelivered
    </button>
  );
}
