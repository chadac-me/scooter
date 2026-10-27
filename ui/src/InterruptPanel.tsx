/**
 * Interrupt panel: renders the agent's pending option/permission requests as inline
 * buttons and resumes the run with the user's pick.
 *
 * The agent-host pauses a run with an AG-UI interrupt (RUN_FINISHED outcome
 * "interrupt") that rides the per-conversation integrity log, so pending interrupts
 * are read and answered through the IntegrityAgent (useConversationInterrupts), not
 * the runtime's interrupt API. The answer is a POST /agui with resume[], and the
 * continuation streams back through the same log. Each interrupt's metadata.options
 * carries { optionId, name, kind } choices.
 */

import { useEffect, useState } from "react";
import { hasId, type MaybeConversationId } from "./conversation.js";

import { useConversationInterrupts } from "./RuntimeProvider.js";
import type { PendingInterrupt } from "./integrityAgent.js";
import { contribApprovals, contribInterruptRenderers } from "./contribManifest.js";
import { ContribInterruptCard } from "./contribInterrupts.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Option {
  optionId: string;
  name: string;
  kind: string;
}

function optionsOf(intr: PendingInterrupt): Option[] {
  const raw = intr.metadata?.options;
  return Array.isArray(raw) ? (raw as Option[]) : [];
}

/** The request kind and data an interrupt carries for a contrib renderer, or undefined for a plain choice. */
export function requestOf(intr: PendingInterrupt): { kind: string; data: unknown } | undefined {
  const kind = intr.metadata?.kind;
  return typeof kind === "string" && kind ? { kind, data: intr.metadata?.data } : undefined;
}

/** The contrib name and requestId an approval interrupt carries in its metadata, or
 *  undefined for a non-approval interrupt (exported for unit testing). */
export function approvalOf(intr: PendingInterrupt): { contrib: string; requestId: string } | undefined {
  const m = intr.metadata;
  if (!m || typeof m.contrib !== "string" || !m.contrib) return undefined;
  return {
    contrib: m.contrib,
    requestId: typeof m.requestId === "string" ? m.requestId : intr.id,
  };
}

/**
 * Whether this viewer may approve an approval interrupt, asked live from the host;
 * undefined while loading or for a non-approval interrupt, which the caller treats
 * as allowed.
 */
function useCanApprove(
  approval: { contrib: string; requestId: string } | undefined,
  conversationId: MaybeConversationId,
  baseUrl: string,
): boolean | undefined {
  const [can, setCan] = useState<boolean | undefined>(undefined);
  // Depend on the fields, not the object, which `approvalOf` rebuilds every render.
  const contrib = approval?.contrib;
  const requestId = approval?.requestId;
  useEffect(() => {
    if (!contrib || !requestId || !hasId(conversationId)) return;
    let cancelled = false;
    fetch(
      `${baseUrl}/conversations/${encodeURIComponent(conversationId)}/approvals/${encodeURIComponent(contrib)}/${encodeURIComponent(requestId)}/can-approve`,
      { credentials: "include" },
    )
      .then((r) => (r.ok ? r.json() : { canApprove: false }))
      .then((j: { canApprove?: boolean }) => {
        if (!cancelled) setCan(j.canApprove !== false);
      })
      .catch(() => {
        if (!cancelled) setCan(false); // fail closed → greyed
      });
    return () => {
      cancelled = true;
    };
  }, [contrib, requestId, conversationId, baseUrl]);
  return can;
}

/** One pending interrupt: its message plus option buttons, with the gated option
 *  greyed when this viewer may not use it. */
function InterruptCard({
  intr,
  busy,
  answer,
  conversationId,
  baseUrl,
}: {
  intr: PendingInterrupt;
  busy: boolean;
  answer: (intr: PendingInterrupt, status: "resolved" | "cancelled", optionId?: string) => void;
  /** Undefined before the server creates the conversation. */
  conversationId: MaybeConversationId;
  baseUrl: string;
}) {
  const options = optionsOf(intr);
  const approval = approvalOf(intr);
  const canApprove = useCanApprove(approval, conversationId, baseUrl);
  // A contrib absent from the manifest has no gating; greying is a courtesy, and the
  // broker remains the enforcement point.
  const gating = approval ? contribApprovals()[approval.contrib] : undefined;
  // Gate only on an explicit no; loading/unknown leaves it enabled.
  const approveBlocked = approval !== undefined && gating !== undefined && canApprove === false;

  return (
    <div
      className="mb-3 rounded-lg border bg-muted/40 p-3 last:mb-0"
      data-testid="interrupt-request"
    >
      {intr.message && (
        <p className="mb-3 whitespace-pre-wrap text-sm" data-testid="interrupt-message">
          {intr.message}
        </p>
      )}
      <div className="flex flex-col gap-2">
        {options.map((o) => {
          const blocked = approveBlocked && o.optionId === gating?.gatedOption;
          return (
            <Button
              key={o.optionId}
              variant="outline"
              size="sm"
              disabled={busy || blocked}
              data-testid="interrupt-option"
              data-option-id={o.optionId}
              data-blocked={blocked ? "true" : undefined}
              title={blocked ? gating?.blockedTitle : undefined}
              className={cn(blocked && "cursor-not-allowed")}
              onClick={() => !blocked && answer(intr, "resolved", o.optionId)}
            >
              {o.name}
            </Button>
          );
        })}
        {approveBlocked && (
          <p className="text-xs text-muted-foreground" data-testid="interrupt-approve-hint">
            {gating?.blockedHint}
          </p>
        )}
        {/* An explicit dismiss is always offered. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          data-testid="interrupt-cancel"
          className="text-muted-foreground"
          onClick={() => answer(intr, "cancelled")}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/**
 * The pending interrupt cards plus the resume wiring, the content of the Approvals
 * tab (RightPanel owns the chrome). Keeps the `interrupt-panel` testid the e2e specs
 * select by, and renders nothing when no interrupt is pending.
 */
export function InterruptList() {
  const { interrupts: pending, submitResume, conversationId, baseUrl } = useConversationInterrupts();
  const [submitting, setSubmitting] = useState<string | null>(null);

  if (pending.length === 0) return null;

  const answer = async (
    intr: PendingInterrupt,
    status: "resolved" | "cancelled",
    optionId?: string,
    result?: Record<string, unknown>,
  ) => {
    setSubmitting(intr.id);
    try {
      await submitResume([
        { interruptId: intr.id, status, payload: optionId ? { optionId, ...(result ? { result } : {}) } : undefined },
      ]);
    } catch {
      // The provider shows the failure in the send-error banner, and the card stays pending so the user can answer again.
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div data-testid="interrupt-panel" aria-label="Pending approval requests">
      <p className="mb-3 text-xs text-muted-foreground">
        The agent is waiting on your decision to continue.
      </p>
      {pending.map((intr) => {
        const plain = (
          <InterruptCard
            key={intr.id}
            intr={intr}
            busy={submitting === intr.id}
            answer={answer}
            conversationId={conversationId}
            baseUrl={baseUrl}
          />
        );
        const request = requestOf(intr);
        const renderer = request && contribInterruptRenderers()[request.kind];
        // A contrib request is offered one option, which carries the renderer's result.
        const optionId = optionsOf(intr)[0]?.optionId;
        if (!request || !renderer || !optionId) return plain;
        return (
          <ContribInterruptCard
            key={intr.id}
            renderer={renderer}
            fallback={plain}
            props={{
              message: intr.message ?? "",
              data: request.data,
              busy: submitting === intr.id,
              resolve: (result) => void answer(intr, "resolved", optionId, result),
              dismiss: () => void answer(intr, "cancelled"),
            }}
          />
        );
      })}
    </div>
  );
}
