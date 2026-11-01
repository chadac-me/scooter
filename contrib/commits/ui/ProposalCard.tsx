/**
 * ProposalCard: the Approvals-tab card for a `commits.identity` request, an agent's
 * proposed commit identity (host.py's card). Approve writes it unless one is set by
 * then; approving any proposal withdraws the user's other pending ones.
 */

import { Button, cn, type InterruptRendererProps } from "@/src/contrib/sdk";

export interface Proposed {
  name: string;
  email: string;
}

/** The request's data as a proposal, or null when it is not host.py's shape. */
export function proposedOf(data: unknown): Proposed | null {
  const d = data as Record<string, unknown> | null | undefined;
  if (typeof d?.name !== "string" || typeof d?.email !== "string" || !d.name || !d.email) return null;
  return { name: d.name, email: d.email };
}

export default function ProposalCard({ message, data, view, options, blocked, busy, choose, dismiss }: InterruptRendererProps) {
  const p = proposedOf(data);
  // An unrecognised shape fails over to the core's plain Approve/Deny card.
  if (!p) throw new Error(`"${message}" carries no commit identity this card can show`);
  const detail = view === "detail";
  return (
    <div className={cn("space-y-3", !detail && "rounded-lg border bg-muted/40 p-3")} data-testid="commits-proposal-card">
      <div className="space-y-1">
        <p className={cn("font-semibold", detail ? "text-lg" : "text-sm")}>Use this as your commit identity?</p>
        <div className="rounded-md border bg-background px-3 py-2 font-mono text-sm" data-testid="commits-proposed-ident">
          {p.name} &lt;{p.email}&gt;
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Scooter's commits for you will carry this, with Scooter as co-author. Approving withdraws other agents'
        proposals. Change it any time under Commit identity in Settings.
      </p>
      <div className={cn("flex gap-2", detail ? "flex-row-reverse justify-start" : "flex-col")}>
        {options.map((o) => (
          <Button
            key={o.optionId}
            variant={o.kind.startsWith("allow") ? "default" : "outline"}
            size="sm"
            disabled={busy || blocked?.optionId === o.optionId}
            title={blocked?.optionId === o.optionId ? blocked.title : undefined}
            data-testid="interrupt-option"
            data-option-id={o.optionId}
            onClick={() => choose(o.optionId)}
          >
            {o.name}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          data-testid="interrupt-cancel"
          className={cn("text-muted-foreground", detail && "mr-auto")}
          onClick={dismiss}
        >
          Later
        </Button>
      </div>
      {blocked && <p className="text-xs text-muted-foreground">{blocked.hint}</p>}
    </div>
  );
}
