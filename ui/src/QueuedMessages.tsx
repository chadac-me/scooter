/**
 * Queued-messages list: the messages the user sent while a run was in flight, waiting
 * their turn behind it, rendered in the right panel's Queue tab. A message with
 * priority > 0 interrupts the current turn and sorts to the top; priority-0 messages
 * keep their arrival order. The list is read from the QUEUE_UPDATED snapshots on the
 * integrity stream (via RuntimeProvider context), so it survives a refresh and clears
 * itself as the queue drains.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { FiClock, FiZap } from "react-icons/fi";

import { useConversationInterrupts } from "./RuntimeProvider.js";
import { Button } from "@/components/ui/button";

type QueuedMessage = { id: string; text: string; priority: number };

/** Lines to show before clamping; spelled out literally so Tailwind's JIT scanner emits the utility. */
const CLAMP_CLASS = "line-clamp-4";

function QueuedMessageRow({ m }: { m: QueuedMessage }) {
  const priority = m.priority > 0;
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // The toggle is offered only when the clamped text actually overflows.
  const [overflows, setOverflows] = useState(false);

  // Measured after layout: a scrollHeight taller than clientHeight means the text exceeds the clamp.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    setOverflows(el.scrollHeight - el.clientHeight > 1);
  }, [m.text, expanded]);

  return (
    <div
      data-testid="queued-message"
      data-priority={priority ? "true" : undefined}
      className={
        "flex items-start gap-2 rounded-md border px-2 py-1.5 " +
        (priority
          ? "border-warning/40 bg-warning/10 text-foreground"
          : "border-transparent text-muted-foreground")
      }
      title={priority ? "Will interrupt the current turn once it finishes what it is doing" : "Waiting for the current turn to finish"}
    >
      {/* Lightning bolt for a priority message, clock for a waiting one. */}
      <span aria-hidden className={"mt-0.5 shrink-0 " + (priority ? "text-warning" : "text-muted-foreground/70")}>
        {priority ? <FiZap size={13} /> : <FiClock size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        {/* When clamped, line-clamp-4 sets `display:-webkit-box`, so do not also set `block`, which would override it. */}
        <div
          ref={textRef}
          data-testid="queued-message-text"
          className={"whitespace-pre-wrap break-words " + (expanded ? "block" : CLAMP_CLASS)}
        >
          {priority && (
            <span
              data-testid="queued-priority-pill"
              className="mr-1.5 rounded bg-warning/20 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning"
            >
              Priority
            </span>
          )}
          {m.text}
        </div>
        {(overflows || expanded) && (
          <Button
            variant="link"
            size="xs"
            data-testid="queued-message-toggle"
            onClick={() => setExpanded((e) => !e)}
            className="mt-0.5 h-auto p-0 text-muted-foreground"
          >
            {expanded ? "Show less" : "Show more"}
          </Button>
        )}
      </div>
    </div>
  );
}

export function QueuedMessages() {
  const { queuedMessages } = useConversationInterrupts();
  if (queuedMessages.length === 0) return null;

  // Priority messages float to the top, highest first; ties and normal messages keep arrival order.
  const ordered = queuedMessages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.priority - a.m.priority || a.i - b.i)
    .map(({ m }) => m);

  return (
    <div data-testid="queued-messages" className="flex flex-col gap-1.5 text-sm">
      {ordered.map((m) => (
        <QueuedMessageRow key={m.id} m={m} />
      ))}
    </div>
  );
}
