/**
 * Explains, from a sandbox pod's status and events, why it is not Ready yet, so a
 * tool call waiting on it can say "the workspace volume can't attach" instead of
 * timing out with no reason. Also keeps the latest explanation per sandbox while a
 * readiness poll runs, for conversation_status and the exec timeout message.
 */

import type { CoreV1Event, V1Pod } from "@kubernetes/client-node";

import type { SandboxRef } from "../types.js";

/** Event reasons that mean the pod's storage is the holdup, in words an agent can act on. */
const STORAGE_REASONS: Record<string, string> = {
  FailedAttachVolume: "a storage volume can't attach to the node",
  FailedMount: "a storage volume can't be mounted",
  FailedBinding: "a storage volume can't be bound",
  ProvisioningFailed: "a storage volume can't be provisioned",
};

/** Container waiting reasons that will not clear on their own. */
const STUCK_WAITING = new Set(["ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CrashLoopBackOff"]);

/** "12m", "45s": how long the pod has been waiting. */
function age(fromIso: string | Date | undefined, now: number): string {
  if (!fromIso) return "";
  const s = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 1000));
  return s >= 120 ? `${Math.round(s / 60)}m` : `${s}s`;
}

/** Trims a kubelet/attach-detach event message to one readable line. */
function short(msg: string | undefined): string {
  const one = (msg ?? "").replace(/\s+/g, " ").trim();
  return one.length > 240 ? `${one.slice(0, 237)}...` : one;
}

export interface PodNotReady {
  /** One sentence, e.g. "a storage volume can't attach to the node (FailedAttachVolume: ...)". */
  reason: string;
  /** True when storage is the cause, so callers can call it out as a volume problem. */
  storage: boolean;
}

/** Why `pod` is not Ready, from its status and recent events (newest last). */
export function describePodNotReady(
  pod: V1Pod | undefined,
  events: CoreV1Event[] = [],
  now: number = Date.now(),
): PodNotReady {
  if (!pod) return { reason: "no sandbox pod exists yet", storage: false };
  const since = age(pod.metadata?.creationTimestamp, now);
  const forHow = since ? ` (pod waiting ${since})` : "";

  // Warnings only, newest first: an old FailedMount that has since cleared is not the cause
  // if a newer, different warning exists, but the newest storage warning wins over the rest.
  const warnings = events
    .filter((e) => e.type === "Warning")
    .sort((a, b) => eventTime(b) - eventTime(a));
  const storage = warnings.find((e) => e.reason && e.reason in STORAGE_REASONS);
  if (storage) {
    const count = (storage.count ?? 1) > 1 ? `, ${storage.count} times` : "";
    return {
      reason: `${STORAGE_REASONS[storage.reason!]}${forHow}: ${storage.reason}${count}: ${short(storage.message)}`,
      storage: true,
    };
  }
  const sched = warnings.find((e) => e.reason === "FailedScheduling");
  if (sched && pod.status?.phase === "Pending" && !pod.spec?.nodeName) {
    // An unbound PVC shows up as a scheduling failure too.
    const isStorage = /persistentvolumeclaim|volume/i.test(sched.message ?? "");
    return { reason: `the pod can't be scheduled${forHow}: ${short(sched.message)}`, storage: isStorage };
  }
  const waiting = (pod.status?.containerStatuses ?? []).map((c) => c.state?.waiting).find((w) => w?.reason);
  if (waiting && STUCK_WAITING.has(waiting.reason!)) {
    return { reason: `the container is stuck in ${waiting.reason}${forHow}: ${short(waiting.message)}`, storage: false };
  }
  if (pod.status?.phase === "Pending") {
    const what = waiting?.reason === "ContainerCreating" || pod.spec?.nodeName ? "the container is still being created" : "the pod is waiting to be scheduled";
    return { reason: `${what}${forHow}`, storage: false };
  }
  return { reason: `the pod is ${pod.status?.phase ?? "in an unknown phase"} but not Ready${forHow}`, storage: false };
}

function eventTime(e: CoreV1Event): number {
  const t = e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp;
  return t ? new Date(t as string | Date).getTime() : 0;
}

/** What a readiness poll currently knows about a sandbox that is not Ready. */
export interface PodWaitStatus extends PodNotReady {
  /** When this poll started waiting (ms since epoch). */
  since: number;
  /** When the cause was last checked; a check older than STALE_MS is dropped. */
  checkedAt?: number;
}

/** A failed wait's cause is kept this long for conversation_status, then forgotten. */
const STALE_MS = 5 * 60_000;

const waits = new Map<string, PodWaitStatus>();
const key = (ref: Pick<SandboxRef, "namespace" | "name">) => `${ref.namespace}/${ref.name}`;

/** The live not-ready explanation for `ref`, or undefined when no poll is waiting on it. */
export function podWaitStatus(
  ref: Pick<SandboxRef, "namespace" | "name">,
  now: number = Date.now(),
): PodWaitStatus | undefined {
  const w = waits.get(key(ref));
  if (w && now - (w.checkedAt ?? w.since) > STALE_MS) {
    waits.delete(key(ref));
    return undefined;
  }
  return w;
}

export function setPodWaitStatus(ref: Pick<SandboxRef, "namespace" | "name">, status: PodWaitStatus | undefined): void {
  if (status) waits.set(key(ref), { checkedAt: Date.now(), ...status });
  else waits.delete(key(ref));
}

/** The wait as one line for an agent: "sandbox storage is unavailable (Scooter has waited 40s): <reason>". */
export function formatPodWait(status: PodWaitStatus, now: number = Date.now()): string {
  const prefix = status.storage ? "sandbox storage is unavailable" : "sandbox pod is not ready";
  return `${prefix} (Scooter has waited ${age(new Date(status.since), now)}): ${status.reason}`;
}
