/**
 * ToolGroup override that renders consecutive tool calls expanded by default, so
 * the provider message cards and shell commands are visible top-level. Wired in
 * App.tsx via <Thread components={{ ToolGroup: ToolGroupOpen }} />.
 */

import type { PropsWithChildren } from "react";

import {
  ToolGroupRoot,
  ToolGroupTrigger,
  ToolGroupContent,
} from "@/components/assistant-ui/tool-group";
import type { ThreadGroupPart } from "@/components/assistant-ui/thread";

// Render the group's children open, with the count trigger still available to collapse.
export function ToolGroupOpen({ group, children }: PropsWithChildren<{ group: ThreadGroupPart }>) {
  return (
    <ToolGroupRoot variant="ghost" defaultOpen>
      <ToolGroupTrigger count={group.indices.length} active={group.status.type === "running"} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
}
