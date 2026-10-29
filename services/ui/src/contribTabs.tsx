/**
 * Contrib settings tabs: the lazy module table and the body that renders one tab.
 *
 * Every contrib/<name>/ui/*.tsx is compiled into the bundle, one chunk per file, and a
 * chunk is fetched only when the runtime manifest lists its tab and the user opens it.
 * A tab is contained: a missing entry (UI image and manifest out of step), a chunk that
 * fails to load, or a render that throws shows an error card in that tab only.
 */

import { Component, Suspense, lazy, type ComponentType, type ReactNode } from "react";

import { ErrorState } from "@/components/ui/error-state";
import { Spinner } from "@/components/ui/spinner";

import type { ContribSettingsTab } from "./contribTypes.js";

type TabModule = { default: ComponentType<never> };

/** `<contrib>/ui/<file>.tsx` -> loader. Keys match the manifest's `entry`. */
const MODULES: Record<string, () => Promise<TabModule>> = Object.fromEntries(
  Object.entries(import.meta.glob<TabModule>([
    "../../../contrib/*/ui/*.tsx",
    "!../../../contrib/*/ui/*.test.tsx",
  ])).map(([path, load]) => [
    path.replace(/^(\.\.\/)+contrib\//, ""),
    load,
  ]),
);

/** The loader for one bundled contrib module, or undefined when this build lacks it. */
export const contribModuleLoader = (entry: string): (() => Promise<unknown>) | undefined => MODULES[entry];

/** The entries this bundle can load, for tests and diagnostics. */
export const bundledTabEntries = (): string[] => Object.keys(MODULES);

// One lazy component per entry, so switching tabs back and forth does not re-suspend.
const lazyCache = new Map<string, unknown>();
/** The lazy component for one bundled contrib module, or undefined when this build lacks it. */
export function lazyContrib<P extends object = object>(entry: string): ComponentType<P> | undefined {
  const load = MODULES[entry];
  if (!load) return undefined;
  let C = lazyCache.get(entry) as ComponentType<P> | undefined;
  if (!C) {
    C = lazy(async () => {
      const mod = await load();
      if (typeof mod.default !== "function") {
        throw new Error(`${entry} has no default-exported component`);
      }
      return mod as { default: ComponentType<P> };
    });
    lazyCache.set(entry, C);
  }
  return C;
}

interface BoundaryProps {
  children: ReactNode;
  label: string;
}

class TabErrorBoundary extends Component<BoundaryProps, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.warn(`[ui] contrib settings tab "${this.props.label}" failed:`, error);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    const e = this.state.error;
    return (
      <TabError
        label={this.props.label}
        error={e instanceof Error ? e : String(e)}
      />
    );
  }
}

function TabError({ label, error }: { label: string; error: string | Error }) {
  return (
    <ErrorState
      variant="boxed"
      data-testid="contrib-tab-error"
      title={`The ${label} tab failed to load.`}
      error={error}
    />
  );
}

/** One contrib tab's body. Keyed by the caller on the tab id, so the boundary resets
 *  when the user moves to another contrib tab. */
export function ContribTabBody({ tab }: { tab: ContribSettingsTab }) {
  const Tab = lazyContrib(tab.entry);
  if (!Tab) {
    return (
      <TabError
        label={tab.label}
        error={`${tab.entry} is not in this UI build; the UI image and the contrib manifest are out of step.`}
      />
    );
  }
  return (
    <TabErrorBoundary label={tab.label}>
      <Suspense
        fallback={
          <div data-testid="contrib-tab-loading" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading {tab.label}…
          </div>
        }
      >
        <Tab />
      </Suspense>
    </TabErrorBoundary>
  );
}
