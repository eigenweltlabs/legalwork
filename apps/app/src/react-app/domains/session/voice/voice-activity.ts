import type { UIMessage } from "ai";

import { legalMemoryActivityLabel } from "@/lib/legalmemory-activity";
import { getToolActivityLabel, isToolPartInFlight } from "@/lib/tool-activity";

export type VoiceActivityItem = {
  id: string;
  label: string;
  state: "active" | "complete" | "error";
};

/**
 * Turns the task agent's structured tool events into a small, user-safe activity
 * trail. Reasoning text and raw tool input/output intentionally stay out of the
 * voice layer.
 */
export function collectVoiceActivity(messages: UIMessage[], limit = 6): VoiceActivityItem[] {
  const items = new Map<string, VoiceActivityItem>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      items.set(part.toolCallId, {
        id: part.toolCallId,
        label: legalMemoryActivityLabel(part.toolName, part.input) ?? getToolActivityLabel(part),
        state: part.state === "output-error"
          ? "error"
          : isToolPartInFlight(part)
            ? "active"
            : "complete",
      });
    }
  }

  return Array.from(items.values()).slice(-limit);
}
