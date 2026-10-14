/**
 * The Sandbox tab: the current conversation's pod lifecycle status with a Start button
 * when down, its resource allotment and size picker, and, while running, its web services
 * and modules. Status is fetched directly for the current conversation rather than read
 * off the sessions store, and services are enumerable only while the pod is running.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RotateCw, Plus } from "lucide-react";

import {
  resumeConversation,
  loadSandboxReady,
  loadSandboxResources,
  loadSandboxSizes,
  setSandboxSize,
  loadWebServices,
  startWebService,
  stopWebService,
  searchModules,
  installModule,
  type WebService,
  type RegistryModule,
  type SandboxResources,
  type SandboxSizePreset,
} from "./client.js";
import { agentHostConfig } from "./config.js";
import { useSessions, currentConversation } from "./sessions.js";
import { ServiceRows } from "./ServicesPanel.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

export type SandboxState = "running" | "suspended" | "ended" | "starting" | "unknown";

/** Whether a services poll returned the same list, field by field. */
export const sameServices = (a: WebService[], b: WebService[]) =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    return (
      x.name === y.name &&
      x.displayName === y.displayName &&
      x.url === y.url &&
      x.running === y.running
    );
  });

/** Live pod status for the current conversation, a resume action with progress, and the service list with controls. */
export function useSandboxStatus() {
  const { currentId } = useSessions();
  const [serverStatus, setServerStatus] = useState<string | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [services, setServices] = useState<WebService[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // `ready` stays false while the pod is still ContainerCreating even though the status is "running".
  const refreshStatus = useCallback(async () => {
    const res = await currentConversation()?.ifCreated(
      (id) => loadSandboxReady({ baseUrl: BASE_URL }, id),
      { status: "unknown", ready: false },
    );
    if (!res) return;
    if (res.status && res.status !== "unknown") setServerStatus(res.status);
    setReady(res.ready);
  }, [currentId]);

  const refreshServices = useCallback(async (refresh = false) => {
    const svcs = await currentConversation()?.ifCreated(
      (id) => loadWebServices({ baseUrl: BASE_URL }, id, { refresh }),
      [] as Awaited<ReturnType<typeof loadWebServices>>,
    );
    // Keep the previous array when the poll returns the same services, since a fresh reference re-renders every consumer each tick.
    if (svcs) setServices((prev) => (sameServices(prev, svcs) ? prev : svcs));
  }, [currentId]);

  useEffect(() => {
    setServerStatus(undefined); // reset on conversation switch
    setReady(false);
    void refreshStatus();
    void refreshServices();
    const t = setInterval(() => {
      void refreshStatus();
      void refreshServices();
    }, 4000);
    return () => clearInterval(t);
  }, [refreshStatus, refreshServices]);

  // The resume is done only when the pod is actually ready.
  useEffect(() => {
    if (serverStatus === "running" && ready) setStarting(false);
  }, [serverStatus, ready]);

  // Nothing in the pod tells the host about a newly declared service, so the list is re-read on demand too.
  const [rescanning, setRescanning] = useState(false);
  const rescanServices = useCallback(async () => {
    setRescanning(true);
    try {
      await refreshServices(true);
    } finally {
      setRescanning(false);
    }
  }, [refreshServices]);

  const startSandbox = useCallback(async () => {
    const conv = currentConversation();
    if (!conv) return;
    setStarting(true);
    // Starting the sandbox creates the conversation if it does not exist yet.
    const res = await conv
      .withId((id) => resumeConversation({ baseUrl: BASE_URL }, id))
      .catch(() => null);
    if (!res) {
      setStarting(false);
      return;
    }
    await refreshStatus();
    await refreshServices();
  }, [currentId, refreshStatus, refreshServices]);

  const act = async (name: string, fn: typeof startWebService) => {
    setBusy((b) => ({ ...b, [name]: true }));
    await currentConversation()
      ?.withId((id) => fn({ baseUrl: BASE_URL }, id, name))
      .catch(() => undefined);
    await refreshServices();
    setBusy((b) => ({ ...b, [name]: false }));
  };

  // A pod that is "running" but not ready, or a resume in flight, shows as "starting".
  const state: SandboxState =
    serverStatus === "running"
      ? ready
        ? "running"
        : "starting"
      : starting
        ? "starting"
        : (serverStatus as SandboxState) ?? "unknown";

  return {
    state,
    starting,
    services,
    busy,
    rescanServices,
    rescanning,
    conversationId: currentId ?? undefined,
    startSandbox,
    startService: (name: string) => void act(name, startWebService),
    stopService: (name: string) => void act(name, stopWebService),
    hasConversation: !!currentId,
  };
}

export const LABEL: Record<SandboxState, string> = {
  running: "Running",
  suspended: "Suspended",
  ended: "Ended",
  starting: "Starting…",
  unknown: "Checking…",
};

export const DOT: Record<SandboxState, string> = {
  running: "bg-success",
  suspended: "bg-warning",
  ended: "bg-muted-foreground/40",
  starting: "bg-warning animate-pulse",
  unknown: "bg-muted-foreground/40 animate-pulse",
};

/** Status-banner tint per state. */
const BANNER: Record<SandboxState, string> = {
  running: "border-success/30 bg-success/10",
  suspended: "border-warning/30 bg-warning/10",
  starting: "border-warning/30 bg-warning/10",
  ended: "border-border bg-muted/40",
  unknown: "border-border bg-muted/30",
};

const BANNER_TEXT: Record<SandboxState, string> = {
  running: "Sandbox running",
  suspended: "Sandbox suspended",
  starting: "Starting sandbox…",
  ended: "Sandbox ended",
  unknown: "Checking sandbox…",
};

/** A section heading in the Sandbox tab. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/** Search and install Nix modules from the broker registry into this sandbox, shown only while the pod is running. */
export function ModulesSection({ conversationId }: { conversationId: string }) {
  const [query, setQuery] = useState("");
  const [modules, setModules] = useState<RegistryModule[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Collapsed by default; the "+ Add module" button expands the search and browse list.
  const [expanded, setExpanded] = useState(false);

  const runSearch = useCallback(async (q: string) => {
    setLoading(true);
    const res = await searchModules(agentHostConfig, conversationId, q);
    setConfigured(res.configured);
    setModules(res.modules);
    setLoading(false);
  }, [conversationId]);

  useEffect(() => { void runSearch(""); }, [runSearch]);

  const install = async (ref: string) => {
    setInstalling(ref);
    setNote(null);
    try {
      const msg = await installModule(agentHostConfig, conversationId, ref);
      setNote(msg);
      await runSearch(query); // refresh the attached flags
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setInstalling(null);
    }
  };

  const installedCount = modules.filter((m) => m.attached).length;

  return (
    <div data-testid="modules-section" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Modules</SectionLabel>
        <span
          data-testid="modules-installed-count"
          className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {installedCount === 0 ? "none installed" : `${installedCount} installed`}
        </span>
      </div>

      {!configured ? (
        <p data-testid="modules-unavailable" className="text-xs text-muted-foreground">
          The module registry isn’t available.
        </p>
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            data-testid="modules-add-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="self-start"
          >
            <Plus className="size-3.5" aria-hidden />
            Add module
          </Button>

          {expanded ? (
            <div className="flex flex-col gap-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void runSearch(query);
                }}
                className="flex gap-1"
              >
                <input
                  data-testid="module-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search modules…"
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
                />
                <Button variant="outline" size="xs" type="submit">
                  Search
                </Button>
              </form>

              {loading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : modules.length === 0 ? (
                <p data-testid="modules-empty" className="text-xs text-muted-foreground">No modules found.</p>
              ) : (
                <ul data-testid="module-list" className="flex flex-col gap-1">
                  {modules.map((m) => (
                    <li key={m.id} data-testid="module-item" className="flex items-start gap-2 rounded-md border p-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">{m.name}</span>
                          {m.visibility === "private" && (
                            <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">private</span>
                          )}
                        </div>
                        {m.description && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{m.description}</p>}
                      </div>
                      {m.attached ? (
                        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-success/15 text-success">
                          installed
                        </span>
                      ) : (
                        <Button
                          variant="outline"
                          size="xs"
                          data-testid="module-install"
                          disabled={installing === m.name}
                          onClick={() => void install(m.name)}
                          className="shrink-0"
                        >
                          {installing === m.name ? "Installing…" : "Install"}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {note && <p data-testid="module-note" className="text-[11px] text-muted-foreground">{note}</p>}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Whether a resources object carries any value worth showing. */
function hasResources(r: SandboxResources | null | undefined): r is SandboxResources {
  if (!r) return false;
  const sides = [r.requests, r.limits];
  return sides.some((q) => q && (q.cpu !== undefined || q.memory !== undefined || q.gpu !== undefined));
}

/** Format one side (requests or limits) as "cpu · memory · N GPU", omitting absent fields. */
function formatQuantity(q: SandboxResources["requests"]): string {
  if (!q) return "";
  const parts: string[] = [];
  if (q.cpu) parts.push(`${q.cpu} CPU`);
  if (q.memory) parts.push(q.memory);
  if (q.gpu) parts.push(`${q.gpu} GPU`);
  return parts.join(" · ");
}

/** The sandbox's resource allotment: requests (guaranteed) and limits (ceiling). */
export function ResourcesSection({ resources }: { resources: SandboxResources }) {
  const requests = formatQuantity(resources.requests);
  const limits = formatQuantity(resources.limits);
  return (
    <div data-testid="sandbox-resources">
      <div className="mb-1 text-xs font-medium text-muted-foreground">Resources</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {requests && (
          <>
            <dt className="text-muted-foreground" title="Guaranteed — reserved for this sandbox">
              Requested
            </dt>
            <dd data-testid="sandbox-resources-requests" className="font-mono text-foreground">{requests}</dd>
          </>
        )}
        {limits && (
          <>
            <dt className="text-muted-foreground" title="Ceiling — the sandbox can burst up to this">
              Limit
            </dt>
            <dd data-testid="sandbox-resources-limits" className="font-mono text-foreground">{limits}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** The preset name whose cpu/memory/gpu match the current allotment, or "" when none does (shown as "Custom"). */
export function matchPreset(
  sizes: Record<string, SandboxSizePreset>,
  resources: SandboxResources | null | undefined,
): string {
  const limits = resources?.limits;
  if (!limits) return "";
  return (
    Object.keys(sizes).find((name) => {
      const p = sizes[name];
      return p.cpu === limits.cpu && p.memory === limits.memory && (p.gpu ?? undefined) === (limits.gpu ?? undefined);
    }) ?? ""
  );
}

/** One preset rendered for the dropdown: "medium — 2 CPU · 4Gi · 1 GPU". */
function formatPreset(name: string, p: SandboxSizePreset): string {
  const parts = [`${p.cpu} CPU`, p.memory];
  if (p.gpu) parts.push(`${p.gpu} GPU`);
  return `${name} — ${parts.join(" · ")}`;
}

export interface SizeSectionProps {
  sizes: Record<string, SandboxSizePreset>;
  /** The currently-applied allotment, used to derive the selected option. */
  resources?: SandboxResources | null;
  onSelect: (size: string) => void;
  /** A write is in flight, so the select is disabled. */
  saving?: boolean;
  /** The server's rejection message, shown inline rather than silently reverting. */
  error?: string | null;
  /** A size was recorded and is waiting for the next restart to take effect. */
  pendingRestart?: boolean;
}

/** The sandbox size picker over the deployment's named presets. */
export function SizeSection({ sizes, resources, onSelect, saving, error, pendingRestart }: SizeSectionProps) {
  const names = Object.keys(sizes);
  const selected = matchPreset(sizes, resources);
  // Absent for "Custom" and for presets without a hint.
  const hint = selected ? (sizes[selected]?.hint ?? "") : "";
  return (
    <div data-testid="sandbox-size">
      <div className="mb-1 text-xs font-medium text-muted-foreground">Size</div>
      <select
        data-testid="sandbox-size-select"
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
        value={selected}
        disabled={saving}
        onChange={(e) => onSelect(e.target.value)}
      >
        {/* Present only when the applied size matches no preset, and not selectable. */}
        {selected === "" ? (
          <option value="" disabled>
            Custom
          </option>
        ) : null}
        {names.map((name) => (
          <option key={name} value={name}>
            {formatPreset(name, sizes[name])}
          </option>
        ))}
      </select>
      {/* The selected preset's guidance, kept out of the option labels because an <option> cannot wrap. */}
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="sandbox-size-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="mt-1 text-xs text-destructive" data-testid="sandbox-size-error">
          {error}
        </p>
      ) : pendingRestart ? (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="sandbox-size-pending">
          Takes effect when the sandbox next restarts.
        </p>
      ) : null}
    </div>
  );
}

export interface SandboxPanelViewProps {
  state: SandboxState;
  services: WebService[];
  busy: Record<string, boolean>;
  conversationId?: string;
  /** The conversation's owner, or undefined/null when unowned. */
  owner?: string | null;
  /** The sandbox's resource allotment, not shown when null or empty. */
  resources?: SandboxResources | null;
  /** The deployment's named size presets; empty hides the size picker. */
  sizes?: Record<string, SandboxSizePreset>;
  onSelectSize?: (size: string) => void;
  sizeSaving?: boolean;
  sizeError?: string | null;
  sizePendingRestart?: boolean;
  onStartSandbox: () => void;
  onStartService: (name: string) => void;
  onStopService: (name: string) => void;
  /** Re-read the in-pod service manifest to pick up a just-declared service without waiting. */
  onRescanServices?: () => void;
  rescanning?: boolean;
}

/** Pure view: the status banner and, when running, the service list, else a Start prompt. */
export function SandboxPanelView({
  state,
  services,
  busy,
  conversationId,
  owner,
  resources,
  sizes,
  onSelectSize,
  sizeSaving,
  sizeError,
  sizePendingRestart,
  onStartSandbox,
  onStartService,
  onStopService,
  onRescanServices,
  rescanning,
}: SandboxPanelViewProps) {
  // The "+ Service" card reveals an explainer, since services are declared in-sandbox rather than created here.
  const [showAddHint, setShowAddHint] = useState(false);

  return (
    <div className="flex flex-col gap-4" data-testid="sandbox-panel">
      {/* The status banner hosts the contextual action: Start when down, Rescan when running. */}
      <div
        data-testid="sandbox-status-banner"
        className={cn("flex items-center gap-2 rounded-lg border px-3 py-2.5", BANNER[state])}
      >
        <span className={cn("inline-block h-2.5 w-2.5 rounded-full", DOT[state])} aria-hidden />
        <span className="text-sm font-medium" data-testid="sandbox-state" data-state={state}>
          {BANNER_TEXT[state]}
        </span>
        {(state === "suspended" || state === "starting") && (
          <Button
            variant="default"
            size="xs"
            data-testid="sandbox-start"
            disabled={state === "starting"}
            onClick={onStartSandbox}
            className="ml-auto"
          >
            {state === "starting" ? "Starting…" : "Start sandbox"}
          </Button>
        )}
        {state === "running" && onRescanServices ? (
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="sandbox-rescan-services"
            disabled={rescanning}
            onClick={onRescanServices}
            title="Re-read the sandbox's service manifest (after scooter-rebuild)"
            aria-label="Rescan services"
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            {rescanning ? <span className="text-xs">Rescanning…</span> : <RotateCw className="size-4" aria-hidden />}
          </Button>
        ) : null}
      </div>

      {/* Hidden when unowned. */}
      {owner ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="sandbox-owner">
          <span className="font-medium">Owner</span>
          <span data-testid="sandbox-owner-value">{owner}</span>
        </div>
      ) : null}

      {/* Shown regardless of running state, since the size is set even while suspended. */}
      {hasResources(resources) ? <ResourcesSection resources={resources} /> : null}

      {/* Only when the deployment configured presets and a write path is wired. */}
      {sizes && Object.keys(sizes).length > 0 && onSelectSize ? (
        <SizeSection
          sizes={sizes}
          resources={resources}
          onSelect={onSelectSize}
          saving={sizeSaving}
          error={sizeError}
          pendingRestart={sizePendingRestart}
        />
      ) : null}

      {/* Services and modules when running, a hint otherwise. */}
      {state === "running" ? (
        <>
          <section className="flex flex-col gap-2">
            <SectionLabel>Web services</SectionLabel>
            {services.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="sandbox-no-services">
                No web services declared in this sandbox.
              </p>
            ) : null}
            <ServiceRows
              services={services}
              starting={busy}
              onStart={onStartService}
              onStop={onStopService}
              onAdd={() => setShowAddHint((v) => !v)}
            />
            {showAddHint ? (
              <p
                data-testid="service-add-hint"
                className="rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground"
              >
                Web services are declared inside the sandbox — install a module below, or ask Scooter
                to add one (e.g. a terminal or VS Code) with <span className="font-mono">scooter-rebuild</span>.
                {onRescanServices ? " Use the ↻ button above to re-scan once it's added." : ""}
              </p>
            ) : null}
          </section>
          {conversationId && <ModulesSection conversationId={conversationId} />}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {state === "suspended"
            ? "The sandbox pod is suspended (idle). Start it to reach its web services."
            : state === "starting"
              ? "Bringing the sandbox pod up… services appear once it's running."
              : state === "ended"
                ? "This conversation was ended; its sandbox is gone."
                : "Checking the sandbox status…"}
        </p>
      )}
    </div>
  );
}

export function SandboxPanel() {
  const s = useSandboxStatus();
  const { sessions, currentId } = useSessions();
  const owner = sessions.find((x) => x.id === currentId)?.owner ?? null;

  // Re-fetched when the pod comes up, since the broker applies a pending size on restart.
  const [resources, setResources] = useState<SandboxResources | null>(null);
  useEffect(() => {
    if (!currentId) return;
    let alive = true;
    void currentConversation()
      ?.ifCreated(
        (id) => loadSandboxResources({ baseUrl: BASE_URL }, id),
        null as Awaited<ReturnType<typeof loadSandboxResources>>,
      )
      .then((r) => {
      if (alive) setResources(r);
    });
    return () => {
      alive = false;
    };
  }, [currentId, s.state]);

  // The preset table is deployment-wide, so it is fetched once.
  const [sizes, setSizes] = useState<Record<string, SandboxSizePreset>>({});
  useEffect(() => {
    let alive = true;
    void loadSandboxSizes({ baseUrl: BASE_URL }).then((r) => {
      if (alive) setSizes(r.sizes);
    });
    return () => {
      alive = false;
    };
  }, []);

  const [sizeSaving, setSizeSaving] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [sizePendingRestart, setSizePendingRestart] = useState(false);

  const onSelectSize = (size: string) => {
    const preset = sizes[size];
    // Bail before setting `saving`, or the select would stay disabled with no request in flight to re-enable it.
    const conv = currentConversation();
    if (!preset || !conv) return;
    setSizeSaving(true);
    setSizeError(null);
    void conv
      .ifCreated((id) => setSandboxSize({ baseUrl: BASE_URL }, id, size), "no conversation" as string | null)
      .then((err) => {
        setSizeSaving(false);
        if (err) {
          setSizeError(err);
          return;
        }
        setSizePendingRestart(true);
        // Reflect the pick immediately, because re-reading /resources would return the old size until the next restart.
        setResources({
          requests: { cpu: preset.cpu, memory: preset.memory, gpu: preset.gpu },
          limits: { cpu: preset.cpu, memory: preset.memory, gpu: preset.gpu },
        });
      });
  };

  return (
    <SandboxPanelView
      state={s.state}
      services={s.services}
      busy={s.busy}
      onRescanServices={s.rescanServices}
      rescanning={s.rescanning}
      conversationId={s.conversationId}
      owner={owner}
      resources={resources}
      sizes={sizes}
      onSelectSize={onSelectSize}
      sizeSaving={sizeSaving}
      sizeError={sizeError}
      sizePendingRestart={sizePendingRestart}
      onStartSandbox={() => void s.startSandbox()}
      onStartService={s.startService}
      onStopService={s.stopService}
    />
  );
}
