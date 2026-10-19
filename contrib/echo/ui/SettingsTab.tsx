// The echo contrib's settings tab: the fixture for contrib settings tabs. Static on
// purpose, so a test failure here is about loading and routing, not about the tab.
import { useWhoami } from "@/src/contrib/sdk";

export default function EchoSettingsTab() {
  const whoami = useWhoami();
  return (
    <div className="space-y-2" data-testid="echo-settings-tab">
      <h2 className="text-lg font-semibold">Echo</h2>
      <p className="text-sm text-muted-foreground">
        Signed in as {whoami.anonymous ? "anonymous" : (whoami.email ?? whoami.id)}.
      </p>
    </div>
  );
}
