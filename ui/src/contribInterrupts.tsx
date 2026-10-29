/**
 * Contrib interrupt renderers: the card a contrib draws in the Approvals tab for one
 * request kind. The module loads lazily from the same table as settings tabs. A missing
 * entry, a chunk that fails to load, or a render that throws shows an error with the
 * core's plain option buttons under it, so the user can always unblock the agent.
 */

import { Component, Suspense, lazy, type ComponentType, type ReactNode } from "react";

import { ErrorState } from "@/components/ui/error-state";
import { Spinner } from "@/components/ui/spinner";

import type { InterruptRendererProps } from "./contrib/sdk.js";
import type { ContribInterruptRenderer } from "./contribTypes.js";
import { contribModuleLoader } from "./contribTabs.js";

type RendererModule = { default: ComponentType<InterruptRendererProps> };

const lazyCache = new Map<string, ComponentType<InterruptRendererProps>>();
function lazyFor(entry: string): ComponentType<InterruptRendererProps> | undefined {
  const load = contribModuleLoader(entry) as (() => Promise<RendererModule>) | undefined;
  if (!load) return undefined;
  let C = lazyCache.get(entry);
  if (!C) {
    C = lazy(async () => {
      const mod = await load();
      if (typeof mod.default !== "function") throw new Error(`${entry} has no default-exported component`);
      return mod;
    });
    lazyCache.set(entry, C);
  }
  return C;
}

function RendererError({ error, fallback }: { error: string | Error; fallback: ReactNode }) {
  return (
    <div data-testid="contrib-interrupt-error">
      <ErrorState variant="boxed" title="This request's card failed to load." error={error} />
      <div className="mt-2">{fallback}</div>
    </div>
  );
}

class RendererBoundary extends Component<{ children: ReactNode; entry: string; fallback: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.warn(`[ui] contrib interrupt renderer "${this.props.entry}" failed:`, error);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    const e = this.state.error;
    return <RendererError error={e instanceof Error ? e : String(e)} fallback={this.props.fallback} />;
  }
}

/** One pending request drawn by its contrib's renderer; `fallback` is the core card shown if the renderer cannot draw. */
export function ContribInterruptCard({
  renderer,
  props,
  fallback,
}: {
  renderer: ContribInterruptRenderer;
  props: InterruptRendererProps;
  fallback: ReactNode;
}) {
  const Card = lazyFor(renderer.entry);
  if (!Card) {
    return (
      <RendererError
        error={`${renderer.entry} is not in this UI build; the UI image and the contrib manifest are out of step.`}
        fallback={fallback}
      />
    );
  }
  return (
    <div data-testid="contrib-interrupt" data-contrib={renderer.contrib}>
      <RendererBoundary entry={renderer.entry} fallback={fallback}>
        <Suspense
          fallback={
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Loading…
            </div>
          }
        >
          <Card {...props} />
        </Suspense>
      </RendererBoundary>
    </div>
  );
}
