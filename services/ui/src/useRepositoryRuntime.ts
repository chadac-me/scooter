/**
 * A minimal external-store runtime for scooter's single-source render model: the
 * IntegrityAgent folds the log, and this hands assistant-ui the resulting
 * `messageRepository` snapshot. The core reconciles per message (add, keep in place,
 * delete and resetHead), so unchanged messages are not re-painted and the viewport
 * stays pinned at the head. Only the surface scooter uses is wired (the repository
 * render, `onNew`, `isRunning`, and the thread-list and attachment adapters);
 * interrupts and run state come from the IntegrityAgent via context, not this runtime.
 */

import { useMemo } from "react";
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type AttachmentAdapter,
  type ExternalStoreThreadListAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";

import type { RepositorySnapshot } from "./messageRepository.js";

export interface RepositoryRuntimeOptions {
  /** The current message-repository snapshot: a new object each render with stable
   *  inner ids, since the core skips the reconcile when it is reference-equal to the
   *  previous one. */
  messageRepository: RepositorySnapshot;
  /** Whether a run is in flight (drives the composer's running state / Stop). */
  isRunning: boolean;
  /** The composer send, receiving the appended user message whose text and images
   *  RuntimeProvider forwards to the agent-host. */
  onNew: (message: AppendMessage) => Promise<void>;
  adapters?: {
    threadList?: ExternalStoreThreadListAdapter;
    attachments?: AttachmentAdapter;
  };
}

/** Build the assistant-ui runtime from a message-repository snapshot; the per-message
 *  reconcile is a no-op for messages whose ids did not change. */
export function useRepositoryRuntime(options: RepositoryRuntimeOptions) {
  const { messageRepository, onNew, adapters } = options;
  // The runtime is always told "not running": assistant-ui disables composer submission
  // while running, but scooter queues a message sent mid-run, and our own run state
  // comes from useConversationInterrupts.
  const runtimeIsRunning = false;
  return useExternalStoreRuntime<ThreadMessage>(
    useMemo(
      () => ({
        // The repository (not flat `messages`) takes the incremental reconcile path, and
        // the items are already ThreadMessage, so convertMessage is the identity.
        convertMessage: (m: ThreadMessage) => m,
        messageRepository,
        isRunning: runtimeIsRunning,
        onNew,
        adapters: {
          threadList: adapters?.threadList,
          attachments: adapters?.attachments,
        },
      }),
      [messageRepository, runtimeIsRunning, onNew, adapters?.threadList, adapters?.attachments],
    ),
  );
}
