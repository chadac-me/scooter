/**
 * PermissionsCard: the approval card for an `aws.permissions` request, whose data is the
 * broker's approval_data (models.py). The brief view shows the account, risk, reason and
 * how many actions write; the detail view lists every statement with write actions marked,
 * the managed policies, and the raw policy JSON.
 */

import { useState } from "react";

import { Button, cn, type InterruptRendererProps } from "@/src/contrib/sdk";

export interface Statement {
  effect: string;
  actions: string[];
  resources: string[];
  condition?: unknown;
}

export interface Grant {
  account: string;
  risk: string;
  justification: string;
  summary: string;
  policyDocument: Record<string, unknown> | null;
  managedPolicyArns: string[];
  writeActions: string[];
  parentRequestId: string | null;
}

const asList = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The request's data as a Grant, or null when it is not the broker's shape. */
export function grantOf(data: unknown): Grant | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.account !== "string" || typeof d.risk !== "string") return null;
  const policy = d.policy_document;
  return {
    account: d.account,
    risk: d.risk,
    justification: str(d.justification),
    summary: str(d.summary),
    policyDocument: policy && typeof policy === "object" ? (policy as Record<string, unknown>) : null,
    managedPolicyArns: asList(d.managed_policy_arns),
    writeActions: asList(d.write_actions),
    parentRequestId: str(d.parent_request_id) || null,
  };
}

/** A policy document's statements, with IAM's string-or-list fields as lists. */
export function statementsOf(policy: Record<string, unknown> | null): Statement[] {
  const raw = policy?.Statement;
  // IAM allows a single statement object in place of the list.
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return list
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      effect: str(s.Effect) || "Allow",
      actions: asList(s.Action),
      resources: asList(s.Resource),
      condition: s.Condition,
    }));
}

/** How many actions the statements allow, counting each statement's list. */
export function allowedActionCount(statements: Statement[]): number {
  return statements.reduce((n, s) => n + (s.effect === "Allow" ? s.actions.length : 0), 0);
}

const RISK_STYLE: Record<string, string> = {
  low: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  high: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
};

function RiskBadge({ risk }: { risk: string }) {
  return (
    <span
      className={cn("rounded-md border px-1.5 py-0.5 text-xs font-medium", RISK_STYLE[risk] ?? "bg-muted")}
      data-testid="aws-risk"
    >
      {risk} risk
    </span>
  );
}

type AnswerProps = Pick<InterruptRendererProps, "options" | "blocked" | "busy" | "choose" | "dismiss">;

function Answers({ options, blocked, busy, choose, dismiss, detail }: AnswerProps & { detail: boolean }) {
  return (
    <div className="space-y-2">
      <div className={cn("flex gap-2", detail ? "flex-row-reverse flex-wrap justify-start" : "flex-col")}>
        {options.map((o) => {
          const isBlocked = blocked?.optionId === o.optionId;
          return (
            <Button
              key={o.optionId}
              variant={o.kind.startsWith("allow") ? "default" : "outline"}
              size="sm"
              disabled={busy || isBlocked}
              data-testid="interrupt-option"
              data-option-id={o.optionId}
              data-blocked={isBlocked ? "true" : undefined}
              title={isBlocked ? blocked?.title : undefined}
              className={cn(isBlocked && "cursor-not-allowed")}
              onClick={() => !isBlocked && choose(o.optionId)}
            >
              {o.name}
            </Button>
          );
        })}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          data-testid="interrupt-cancel"
          className={cn("text-muted-foreground", detail && "mr-auto")}
          onClick={dismiss}
        >
          Dismiss
        </Button>
      </div>
      {blocked && (
        <p className="text-xs text-muted-foreground" data-testid="interrupt-approve-hint">
          {blocked.hint}
        </p>
      )}
    </div>
  );
}

function StatementTable({ statements, writes }: { statements: Statement[]; writes: Set<string> }) {
  return (
    <table className="w-full table-fixed border-collapse text-xs" data-testid="aws-statements">
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="w-16 py-1.5 pr-2 font-medium">Effect</th>
          <th className="py-1.5 pr-2 font-medium">Actions</th>
          <th className="py-1.5 pr-2 font-medium">Resources</th>
          <th className="w-1/4 py-1.5 font-medium">Condition</th>
        </tr>
      </thead>
      <tbody>
        {statements.map((s, i) => (
          <tr key={i} className="border-b align-top last:border-0">
            <td className={cn("py-1.5 pr-2", s.effect === "Deny" && "text-red-600")}>{s.effect}</td>
            <td className="py-1.5 pr-2 font-mono">
              {s.actions.map((a) => (
                <div
                  key={a}
                  className={cn("break-all", writes.has(a) && "font-semibold text-amber-700 dark:text-amber-300")}
                >
                  {a}
                  {writes.has(a) && <span className="ml-1 font-sans text-[10px] uppercase">write</span>}
                </div>
              ))}
            </td>
            <td className="py-1.5 pr-2 font-mono">
              {s.resources.map((r) => (
                <div key={r} className="break-all">
                  {r}
                </div>
              ))}
            </td>
            <td className="py-1.5 font-mono text-[11px] break-all whitespace-pre-wrap">
              {s.condition ? JSON.stringify(s.condition, null, 1) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function PermissionsCard({ message, data, view, ...answers }: InterruptRendererProps) {
  const [raw, setRaw] = useState(false);
  const grant = grantOf(data);
  // An unrecognised shape fails over to the core's plain Approve/Deny card.
  if (!grant) throw new Error(`"${message}" carries no AWS grant this card can show`);
  const writes = new Set(grant.writeActions);
  const statements = statementsOf(grant.policyDocument);
  const actionCount = allowedActionCount(statements);

  if (view === "brief") {
    return (
      <div className="space-y-2 rounded-lg border bg-muted/40 p-3" data-testid="aws-permissions-card">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold">AWS · {grant.account}</span>
          <RiskBadge risk={grant.risk} />
        </div>
        {grant.summary && <p className="line-clamp-3 text-sm">{grant.summary}</p>}
        {grant.justification && (
          <p className="line-clamp-2 text-xs text-muted-foreground">Reason: {grant.justification}</p>
        )}
        <p className="text-xs text-muted-foreground" data-testid="aws-write-count">
          {actionCount} action{actionCount === 1 ? "" : "s"}
          {grant.writeActions.length > 0 ? `, ${grant.writeActions.length} write` : ", read-only"}
          {grant.managedPolicyArns.length > 0 && ` + ${grant.managedPolicyArns.length} managed`}
        </p>
        <Answers {...answers} detail={false} />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="aws-permissions-card">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">AWS access to {grant.account}</h2>
          <RiskBadge risk={grant.risk} />
          {grant.parentRequestId && (
            <span className="text-xs text-muted-foreground">extends {grant.parentRequestId}</span>
          )}
        </div>
        {grant.summary && <p className="text-sm">{grant.summary}</p>}
        {grant.justification && <p className="text-sm text-muted-foreground">Reason: {grant.justification}</p>}
      </header>

      {grant.writeActions.length > 0 && (
        <section className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="aws-writes">
          <span className="font-medium">Can change things:</span>{" "}
          <span className="font-mono text-xs">{grant.writeActions.join(", ")}</span>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Policy</h3>
          {grant.policyDocument && (
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setRaw((r) => !r)}>
              {raw ? "Table" : "Raw JSON"}
            </Button>
          )}
        </div>
        {!grant.policyDocument ? (
          <p className="text-sm text-muted-foreground">No inline policy.</p>
        ) : raw ? (
          <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs" data-testid="aws-raw-policy">
            {JSON.stringify(grant.policyDocument, null, 2)}
          </pre>
        ) : (
          <StatementTable statements={statements} writes={writes} />
        )}
      </section>

      {grant.managedPolicyArns.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Managed policies</h3>
          <ul className="font-mono text-xs">
            {grant.managedPolicyArns.map((arn) => (
              <li key={arn} className="break-all">
                {arn}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Answers {...answers} detail />
    </div>
  );
}
