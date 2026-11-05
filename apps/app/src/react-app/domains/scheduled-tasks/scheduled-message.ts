import { ScheduledTaskMessageSchema } from "@legalwork/types/scheduled-tasks";
import type { UIMessage } from "ai";
import type { TextPart } from "@/app/lib/opencode-view";

/** Keep scheduler metadata in both live events and reloaded transcripts. */
export function scheduledTextMetadata(part: Pick<TextPart, "id" | "metadata">) {
  const scheduledTask = ScheduledTaskMessageSchema.safeParse(part.metadata?.legalworkScheduledTask).data;
  return { opencode: { partId: part.id, ...(scheduledTask ? { scheduledTask } : {}) } };
}

export function parseScheduledRunMessage(message: UIMessage) {
  if (message.role !== "user") return null;
  const parts = message.parts.filter(part => part.type === "text");
  const text = parts.map(part => part.text).join("");
  for (const part of parts) {
    const metadata = ScheduledTaskMessageSchema.safeParse(part.providerMetadata?.opencode?.scheduledTask).data;
    if (!metadata) continue;
    const prefix = `[Scheduled task: ${metadata.title}]\n\n`;
    return { ...metadata, prompt: text.startsWith(prefix) ? text.slice(prefix.length) : text };
  }
  // Previously delivered runs have only this text envelope. This is display
  // compatibility, never authority to run a task or grant access.
  const legacy = /^\[Scheduled task: ([^\n]+)\]\r?\n\r?\n([\s\S]+)$/.exec(text);
  return legacy ? { title: legacy[1], prompt: legacy[2], taskId: null, workspaceId: null } : null;
}
