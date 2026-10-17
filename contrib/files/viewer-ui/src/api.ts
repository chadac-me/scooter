// The viewer server's JSON API (contrib/files/viewer/server.py), unchanged.

declare global {
  interface Window {
    __BASE__?: string;
  }
}

// "{{BASE}}" survives only when the page is served by `vite dev`, not the server.
const raw = window.__BASE__ ?? "";
export const BASE = raw.startsWith("{{") ? "" : raw;

export type Entry = { name: string; kind: "dir" | "file"; size: number; skip: boolean; repo: boolean };
export type Listing = { path: string; entries: Entry[] };

export type FileView = {
  path: string;
  size: number;
  body: string;
  lines?: number;
  etag?: string;
  renderer: "code" | "markdown" | "too-large" | "binary";
};

export type Annotation = {
  id: string;
  path: string;
  line: number;
  recorded_line: number;
  quote: string;
  kind: "comment" | "answer";
  text: string;
  thread: string;
  question_id: string;
  by: "reviewer" | "agent";
  resolved: boolean;
  created_at: string;
  state: "pending" | "acked" | "failed" | "disabled";
  error: string;
  anchor_state: "ok" | "moved" | "stale" | "unknown";
};

export type Question = {
  id: string;
  kind: "single" | "multi" | "text";
  prompt: string;
  options: { label: string; checked: boolean }[];
  line: number;
  answers: Annotation[];
  answered: boolean;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, route: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const r = await fetch(`${BASE}/api/${route}${qs}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(data.error ?? `${r.status} ${r.statusText}`, r.status);
  return data as T;
}

export const api = {
  list: (path: string) => call<Listing>("GET", "list", undefined, { path }),
  file: (path: string) => call<FileView>("GET", "file", undefined, { path }),
  annotations: (path: string) =>
    call<{ annotations: Annotation[] }>("GET", "annotations", undefined, { path }).then((r) => r.annotations),
  questions: (path: string) =>
    call<{ questions: Question[] }>("GET", "questions", undefined, { path }).then((r) => r.questions),
  add: (body: {
    path: string;
    line: number;
    quote?: string;
    text: string;
    thread?: string;
    kind?: "comment" | "answer";
    question_id?: string;
  }) => call<{ annotation: Annotation }>("POST", "annotations", body),
  resolve: (thread: string, resolved: boolean) =>
    call("POST", `annotations/threads/${encodeURIComponent(thread)}/resolve`, { resolved }),
  retry: (id: string) => call("POST", `annotations/${encodeURIComponent(id)}/retry`, {}),
  remove: (id: string) => call("DELETE", `annotations/${encodeURIComponent(id)}`),
};

export type Thread = {
  id: string;
  line: number;
  /** The last line the anchor covers: a multi-line quote spans several. */
  endLine: number;
  quote: string;
  resolved: boolean;
  stale: boolean;
  comments: Annotation[];
};

/** Comments grouped into threads, in file order. Answers are shown with their question. */
export function threadsOf(annotations: Annotation[]): Thread[] {
  const byId = new Map<string, Annotation[]>();
  for (const a of annotations) {
    if (a.kind !== "comment") continue;
    byId.set(a.thread, [...(byId.get(a.thread) ?? []), a]);
  }
  return [...byId.entries()]
    .map(([id, comments]) => {
      comments.sort((x, y) => x.created_at.localeCompare(y.created_at));
      const head = comments.find((c) => c.id === id) ?? comments[0];
      return {
        id,
        line: head.line,
        endLine: head.line + Math.max(0, head.quote.split("\n").length - 1),
        quote: head.quote,
        resolved: comments.some((c) => c.resolved),
        stale: head.anchor_state === "stale",
        comments,
      };
    })
    .sort((a, b) => a.line - b.line);
}
