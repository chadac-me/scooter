import { useAuiState } from "@assistant-ui/react";
import { useCallback, useState, type FC, type MouseEvent } from "react";

import { cn } from "@/lib/utils";
import { SENT_AT_KEY } from "@/src/messageRepository";
import { formatMessageTime, formatMessageTimeFull, shouldToggleTimestamp } from "@/src/messageTime";

/** The message's send time in epoch ms, or undefined when the log carried none. */
export function useMessageSentAt(): number | undefined {
  return useAuiState((s) => {
    const v = (s.message.metadata?.custom as Record<string, unknown> | undefined)?.[SENT_AT_KEY];
    return typeof v === "number" ? v : undefined;
  });
}

/**
 * Click-to-show timestamp state for a message root. The root keeps the normal text
 * cursor (no pointer): the message is text first, and the toggle is secondary.
 */
export function useTimestampToggle(): { shown: boolean; onClick: (e: MouseEvent) => void } {
  const [shown, setShown] = useState(false);
  const onClick = useCallback((e: MouseEvent) => {
    if (!shouldToggleTimestamp(e.target, window.getSelection())) return;
    setShown((v) => !v);
  }, []);
  return { shown, onClick };
}

export const MessageTimestamp: FC<{ shown: boolean; className?: string }> = ({ shown, className }) => {
  const sentAt = useMessageSentAt();
  if (!shown || sentAt === undefined) return null;
  return (
    <time
      data-slot="aui_message-timestamp"
      dateTime={new Date(sentAt).toISOString()}
      title={formatMessageTimeFull(sentAt)}
      className={cn(
        "text-muted-foreground animate-in fade-in text-xs tabular-nums duration-150",
        className,
      )}
    >
      {formatMessageTime(sentAt)}
    </time>
  );
};
