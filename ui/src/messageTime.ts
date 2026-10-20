/**
 * Labels for a message's send time, shown when the user clicks a message: a compact
 * label ("2:41 PM", "Yesterday 2:41 PM", "Oct 14, 2:41 PM", "Oct 14, 2025, 2:41 PM")
 * and a full one for the hover title.
 */

const DAY_MS = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The compact label, relative to `now` in the viewer's locale and timezone. */
export function formatMessageTime(ms: number, now: Date = new Date(), locale?: string): string {
  const d = new Date(ms);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(d);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  const date = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  }).format(d);
  return `${date}, ${time}`;
}

/** The full label for the hover title, e.g. "Tuesday, October 20, 2026 at 2:41:07 PM EDT". */
export function formatMessageTimeFull(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "long" }).format(new Date(ms));
}

/**
 * Whether a click on a message should toggle its timestamp: not when it lands on an
 * interactive element (which has its own action), and not when it ends a text selection.
 */
export function shouldToggleTimestamp(target: EventTarget | null, selection: Selection | null): boolean {
  if (selection && !selection.isCollapsed && selection.toString().length > 0) return false;
  const el = target instanceof Element ? target : null;
  if (el?.closest("a, button, input, textarea, select, summary, label, [role='button'], [contenteditable='true']")) {
    return false;
  }
  return true;
}
