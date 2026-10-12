/**
 * The "coming back up" screen shown in the conversation area while an explicit
 * Sandbox-tab Start is in flight (state "starting"), so the click gives immediate
 * feedback while the pod is ContainerCreating. An asleep conversation renders its
 * thread off the persisted integrity stream and sending a message resumes the pod,
 * so this brief spinner is the only takeover.
 */

export function StartingPodLanding() {
  return (
    <div
      data-testid="starting-pod-landing"
      className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" aria-hidden />
      <h2 className="text-lg font-medium">Starting the conversation…</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Bringing the sandbox back up — this takes a few seconds.
      </p>
    </div>
  );
}
