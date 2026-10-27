// Settings → Personalization: the user's profile toggle and notes.
//
// Every call goes through contribFetch, which the agent-host relays to this
// contrib's broker routes at /personalization/user/<path> as the signed-in user.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  contribFetch,
  EmptyState,
  ErrorState,
  Spinner,
  inputClass,
  textareaClass,
} from "@/src/contrib/sdk";

interface Profile {
  enabled: boolean;
  last_analyzed_at: string | null;
  refresh_requested_at: string | null;
  last_run_conversation: string | null;
}

interface Note {
  id: string;
  category: string;
  note: string;
  source: "agent" | "user";
  pinned: boolean;
  updated_at: string;
}

const CATEGORIES: Record<string, string> = {
  "common-asks": "Common asks",
  "agent-habits": "Things agents repeatedly do",
  preferences: "Preferences",
  environment: "Environment",
};

async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await contribFetch("personalization", path, init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function NoteRow({ note, onChange }: { note: Note; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.note);
  const save = async () => {
    await api(`notes/${note.id}`, { method: "PATCH", json: { note: text } });
    setEditing(false);
    onChange();
  };
  const togglePin = async () => {
    await api(`notes/${note.id}`, { method: "PATCH", json: { pinned: !note.pinned } });
    onChange();
  };
  const remove = async () => {
    await api(`notes/${note.id}`, { method: "DELETE" });
    onChange();
  };
  return (
    <li className="flex items-start gap-2 py-1.5" data-testid="personalization-note">
      {editing ? (
        <textarea className={`${textareaClass} flex-1`} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p className="flex-1 text-sm">
          {note.note}
          <span className="ml-2 text-xs text-muted-foreground">
            {note.source === "agent" ? "from analysis" : "yours"}
            {note.pinned ? " · pinned" : ""}
          </span>
        </p>
      )}
      {editing ? (
        <Button size="sm" onClick={save}>Save</Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
      )}
      <Button size="sm" variant="ghost" onClick={togglePin}>{note.pinned ? "Unpin" : "Pin"}</Button>
      <Button size="sm" variant="ghost" onClick={remove}>Delete</Button>
    </li>
  );
}

export default function PersonalizationSettingsTab() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ category: "preferences", note: "" });
  const [requesting, setRequesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, n] = await Promise.all([
        api<{ profile: Profile }>("profile"),
        api<{ notes: Note[] }>("notes"),
      ]);
      setProfile(p.profile);
      setNotes(n.notes);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const by: Record<string, Note[]> = {};
    for (const n of notes) (by[n.category] ??= []).push(n);
    return by;
  }, [notes]);

  if (error) return <ErrorState title="Couldn't load your profile" error={error} />;
  if (!profile) return <Spinner />;

  const setEnabled = async (enabled: boolean) => {
    await api("profile", { method: "PATCH", json: { enabled } });
    await load();
  };
  const refresh = async () => {
    setRequesting(true);
    try {
      await api("refresh", { method: "POST" });
      await load();
    } finally {
      setRequesting(false);
    }
  };
  const queued = profile.refresh_requested_at !== null;
  const add = async () => {
    if (!draft.note.trim()) return;
    await api("notes", { method: "POST", json: draft });
    setDraft({ ...draft, note: "" });
    await load();
  };
  const deleteAll = async () => {
    if (!window.confirm("Delete every note in your profile?")) return;
    await api("notes", { method: "DELETE" });
    await load();
  };

  return (
    <div className="space-y-6" data-testid="personalization-settings-tab">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Personalization</h2>
        <p className="text-sm text-muted-foreground">
          Every so often Scooter reads your recent conversations and keeps short notes
          about how you work, which agents read before starting. You can edit, pin or
          delete any note; analysis never changes notes you wrote or pinned.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={profile.enabled} onChange={(e) => void setEnabled(e.target.checked)} />
          Analyse my conversations
        </label>
        <p className="text-xs text-muted-foreground">
          Last analysed: {profile.last_analyzed_at ? new Date(profile.last_analyzed_at).toLocaleString() : "never"}
          {profile.last_run_conversation ? (
            <> · <a className="underline" href={`/c/${profile.last_run_conversation}`}>latest run</a></>
          ) : null}
          {queued ? " · refresh queued, starts within the hour" : ""}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={refresh}
            disabled={!profile.enabled || queued || requesting}
            title={queued ? "A refresh is already queued" : undefined}
          >
            {requesting ? "Requesting…" : queued ? "Refresh queued" : "Refresh now"}
          </Button>
          <Button size="sm" variant="outline" onClick={deleteAll} disabled={notes.length === 0}>Delete all notes</Button>
        </div>
      </section>

      {notes.length === 0 ? (
        <EmptyState title="No notes yet" description="They appear after the first analysis, or add one below." />
      ) : (
        Object.entries(grouped).map(([cat, items]) => (
          <section key={cat} className="space-y-1">
            <h3 className="text-sm font-semibold">{CATEGORIES[cat] ?? cat}</h3>
            <ul className="divide-y divide-border">
              {items.map((n) => <NoteRow key={n.id} note={n} onChange={() => void load()} />)}
            </ul>
          </section>
        ))
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Add a note</h3>
        <div className="flex gap-2">
          <select aria-label="Category" className={inputClass} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
            {Object.entries(CATEGORIES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <input aria-label="New note" className={`${inputClass} flex-1`} value={draft.note} placeholder="e.g. Open PRs as drafts first"
            onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          <Button size="sm" onClick={add}>Add</Button>
        </div>
      </section>
    </div>
  );
}
