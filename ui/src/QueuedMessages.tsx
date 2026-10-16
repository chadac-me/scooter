/**
 * Queued messages, rendered inline at the tail of the thread: the messages the user sent
 * while a run was in flight, waiting their turn behind it. Each one looks like the user
 * bubble it will become, but faded and with a small status line (spinner + "Queued", or
 * "Sending…" before the server has acknowledged it), so a sent message never "disappears"
 * — it stays where the user expects it and solidifies into a real message once the agent
 * picks it up.
 *
 * A message with priority > 0 interrupts the current turn and sorts to the top; priority-0
 * messages keep their arrival order. The list is read from the QUEUE_UPDATED snapshots on
 * the integrity stream (via RuntimeProvider context) plus optimistic pending sends, so it
 * survives a refresh and clears itself as the queue drains.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { FiZap } from "react-icons/fi";
import { Loader2Icon } from "lucide-react";

import { useConversationInterrupts } from "./RuntimeProvider.js";
import { Button } from "@/components/ui/button";

type QueuedMessage = { id: string; text: string; priority: number };

/** Lines to show before clamping; spelled out literally so Tailwind's JIT scanner emits the utility. */
const CLAMP_CLASS = "line-clamp-6";

/** RuntimeProvider tags not-yet-acknowledged sends with this id prefix. */
const OPTIMISTIC_PREFIX = "optimistic-";

function statusLabel(m: QueuedMessage): string {
  if (m.id.startsWith(OPTIMISTIC_PREFIX)) return "Sending…";
  return m.priority > 0 ? "Interrupting current turn…" : "Queued — waiting for the current turn";
}

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

  const label = statusLabel(m);

  return (
    // Same grid as the real UserMessage so the bubble lines up exactly where it will land.
    <div
      data-testid="queued-message"
      data-priority={priority ? "true" : undefined}
      data-role="user-queued"
      className="fade-in slide-in-from-bottom-1 animate-in grid grid-cols-[minmax(72px,1fr)_auto] gap-y-1 px-2 duration-150"
      title={label}
    >
      <div className="col-start-2 min-w-0 opacity-60">
        <div
          className={
            "rounded-xl border border-dashed px-4 py-2 text-[15px] text-foreground desk:text-base " +
            (priority ? "border-warning/60 bg-warning/10" : "border-muted-foreground/30 bg-muted")
          }
        >
          {/* When clamped, line-clamp sets `display:-webkit-box`, so do not also set `block`, which would override it. */}
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
      <div
        data-testid="queued-message-status"
        className={
          "col-start-2 flex items-center justify-end gap-1 text-xs " +
          (priority ? "text-warning" : "text-muted-foreground")
        }
      >
        {priority ? <FiZap size={11} aria-hidden /> : null}
        <Loader2Icon aria-hidden className="size-3 animate-spin" />
        <span>{label}</span>
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
    <div data-testid="queued-messages" aria-label="Queued messages" className="flex flex-col gap-y-3">
      {ordered.map((m) => (
        <QueuedMessageRow key={m.id} m={m} />
      ))}
    </div>
  );
}
