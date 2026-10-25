/**
 * QuestionCard: the form for an AskUserQuestion interrupt (reason "input_required",
 * metadata.questions). Each question takes one option, several with multiSelect, or
 * typed text, and the card resumes the run with `answers` keyed by question text.
 */

import { useState } from "react";

import type { PendingInterrupt } from "./integrityAgent.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface Question {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect?: boolean;
}

/** What the user has chosen for one question: picked labels plus any typed text. */
export interface Selection {
  picked: string[];
  other: string;
}

/** The questions an interrupt carries, or undefined when it is not a question interrupt. */
export function questionsOf(intr: PendingInterrupt): Question[] | undefined {
  const raw = intr.metadata?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const qs = raw.filter(
    (q): q is Question => typeof q?.question === "string" && Array.isArray(q?.options),
  );
  return qs.length > 0 ? qs : undefined;
}

/** Apply a click on `label` to a selection: a single-select question replaces, a multi-select toggles. */
export function toggle(sel: Selection, label: string, multi: boolean): Selection {
  if (!multi) return { picked: sel.picked[0] === label ? [] : [label], other: sel.other };
  const picked = sel.picked.includes(label) ? sel.picked.filter((l) => l !== label) : [...sel.picked, label];
  return { picked, other: sel.other };
}

/** The answer string for one question: typed text replaces a single pick and joins a multi pick, comma-separated; "" when unanswered. */
export function answerOf(q: Question, sel: Selection | undefined): string {
  if (!sel) return "";
  const other = sel.other.trim();
  if (!q.multiSelect) return other || sel.picked[0] || "";
  return [...q.options.map((o) => o.label).filter((l) => sel.picked.includes(l)), ...(other ? [other] : [])].join(", ");
}

/** The question→answer map to resume with, or undefined until every question is answered. */
export function buildAnswers(questions: Question[], sels: Record<number, Selection>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [i, q] of questions.entries()) {
    const a = answerOf(q, sels[i]);
    if (!a) return undefined;
    out[q.question] = a;
  }
  return out;
}

const EMPTY: Selection = { picked: [], other: "" };

export function QuestionCard({
  intr,
  questions,
  busy,
  onAnswer,
  onDismiss,
}: {
  intr: PendingInterrupt;
  questions: Question[];
  busy: boolean;
  onAnswer: (answers: Record<string, string>) => void;
  onDismiss: () => void;
}) {
  const [sels, setSels] = useState<Record<number, Selection>>({});
  const answers = buildAnswers(questions, sels);
  const update = (i: number, f: (s: Selection) => Selection) => setSels((prev) => ({ ...prev, [i]: f(prev[i] ?? EMPTY) }));

  return (
    <form
      className="mb-3 rounded-lg border border-status-question/40 bg-muted/40 p-3 last:mb-0"
      data-testid="question-request"
      data-interrupt-id={intr.id}
      onSubmit={(e) => {
        e.preventDefault();
        if (answers && !busy) onAnswer(answers);
      }}
    >
      {questions.map((q, i) => {
        const sel = sels[i] ?? EMPTY;
        const preview = q.options.find((o) => o.preview && sel.picked.includes(o.label))?.preview;
        return (
          <fieldset key={i} className="mb-4 last:mb-3" data-testid="question" disabled={busy}>
            <legend className="mb-2 text-sm">
              {q.header && (
                <span className="mr-2 rounded bg-status-question/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-status-question">
                  {q.header}
                </span>
              )}
              <span className="whitespace-pre-wrap" data-testid="question-text">{q.question}</span>
              {q.multiSelect && <span className="ml-1 text-xs text-muted-foreground">(pick any)</span>}
            </legend>
            <div className="flex flex-col gap-1.5">
              {q.options.map((o) => {
                const on = sel.picked.includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    role={q.multiSelect ? "checkbox" : "radio"}
                    aria-checked={on}
                    data-testid="question-option"
                    data-label={o.label}
                    onClick={() => update(i, (s) => toggle(s, o.label, q.multiSelect === true))}
                    className={cn(
                      "rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50",
                      on && "border-status-question bg-status-question/10",
                    )}
                  >
                    <div className="font-medium">{o.label}</div>
                    {o.description && <div className="text-xs text-muted-foreground">{o.description}</div>}
                  </button>
                );
              })}
              {preview && (
                <pre className="max-h-48 overflow-auto rounded-md border bg-card p-2 text-xs" data-testid="question-preview">
                  {preview}
                </pre>
              )}
              <input
                type="text"
                value={sel.other}
                placeholder={q.multiSelect ? "Something else (optional)" : "Or type your own answer"}
                aria-label={`Your own answer to: ${q.question}`}
                data-testid="question-other"
                onChange={(e) => {
                  const other = e.target.value;
                  // Typing replaces a single-select pick, so the card never shows two answers.
                  update(i, (s) => ({ picked: q.multiSelect || !other ? s.picked : [], other }));
                }}
                className="rounded-md border border-input bg-card px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </fieldset>
        );
      })}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !answers} data-testid="question-submit">
          {questions.length > 1 ? "Send answers" : "Send answer"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          data-testid="interrupt-cancel"
          className="text-muted-foreground"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    </form>
  );
}
