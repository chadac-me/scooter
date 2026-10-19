// The echo contrib's settings tab: the fixture for contrib settings tabs. It renders the
// caller from useWhoami() and makes one /contrib-api round-trip, so a failure here is
// about loading, routing or the relay, not about the tab.
import { useEffect, useState } from "react";

import { contribFetch, useWhoami } from "@/src/contrib/sdk";

export default function EchoSettingsTab() {
  const whoami = useWhoami();
  // What the broker saw: the user the agent-host relayed, or the failure status.
  const [relayed, setRelayed] = useState<string>("…");
  useEffect(() => {
    let live = true;
    contribFetch("echo", "whoami")
      .then(async (res) => {
        const text = res.ok ? ((await res.json()) as { user: string }).user : `HTTP ${res.status}`;
        if (live) setRelayed(text);
      })
      .catch(() => live && setRelayed("unreachable"));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="space-y-2" data-testid="echo-settings-tab">
      <h2 className="text-lg font-semibold">Echo</h2>
      <p className="text-sm text-muted-foreground">
        Signed in as {whoami.anonymous ? "anonymous" : (whoami.email ?? whoami.id)}.
      </p>
      <p className="text-sm text-muted-foreground" data-testid="echo-relayed-user">
        The broker sees {relayed}.
      </p>
    </div>
  );
}
