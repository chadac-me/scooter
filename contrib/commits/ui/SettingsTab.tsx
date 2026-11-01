// Settings → Commit identity: the name and email Scooter commits under for this user.
//
// Calls go through contribFetch, relayed to /commits/user/<path> as the signed-in user.
import { useCallback, useEffect, useState } from "react";
import { Button, contribFetch, ErrorState, Spinner, monoInputClass } from "@/src/contrib/sdk";

interface Identity {
  name: string;
  email: string;
  set_by: "user" | "agent";
  updated_at: string;
}

async function api(init?: RequestInit): Promise<Identity | null> {
  const res = await contribFetch("commits", "identity", init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return ((await res.json()) as { identity: Identity | null }).identity;
}

export default function CommitIdentitySettingsTab() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const show = (got: Identity | null) => {
    setIdentity(got);
    setName(got?.name ?? "");
    setEmail(got?.email ?? "");
  };

  const load = useCallback(async () => {
    try {
      show(await api());
      setLoaded(true);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState title="Couldn't load your commit identity" error={error} />;
  if (!loaded) return <Spinner />;

  const run = async (init: RequestInit) => {
    setSaving(true);
    setSaveError(null);
    try {
      show(await api(init));
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const save = () =>
    run({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email }) });
  const clear = () => run({ method: "DELETE" });
  const dirty = name !== (identity?.name ?? "") || email !== (identity?.email ?? "");

  return (
    <div className="space-y-4" data-testid="commit-identity-settings-tab">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Commit identity</h2>
        <p className="text-sm text-muted-foreground">
          In your private conversations, Scooter's commits are authored as you, with Scooter credited as co-author.
          Commits use this name and email, or your linked GitHub or GitLab account if none is set. Scooter may fill this in
          once from your commit history. After that, only you can change it.
        </p>
      </section>
      <section className="space-y-2">
        <label className="block text-sm">
          Name
          <input
            aria-label="Name"
            data-testid="commit-identity-name"
            className={`${monoInputClass} w-full`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          Email
          <input
            aria-label="Email"
            data-testid="commit-identity-email"
            className={`${monoInputClass} w-full`}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {identity && (
          <p className="text-xs text-muted-foreground" data-testid="commit-identity-source">
            Set by {identity.set_by === "agent" ? "Scooter" : "you"} · {new Date(identity.updated_at).toLocaleString()}
          </p>
        )}
        {saveError && <p className="text-xs text-destructive">{saveError}</p>}
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={saving || !dirty || !name || !email}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {identity && (
            <Button size="sm" variant="outline" onClick={clear} disabled={saving}>
              Clear
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
