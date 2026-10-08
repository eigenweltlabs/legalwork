import type { UIMessage } from "ai";
import type { LegalworkSessionSnapshot } from "@/app/lib/legalwork-server";

/** Buffer Assistant prose until each engine message completes; tools stay live. */
export function assistantBubbleMessages(messages: UIMessage[], snapshot: Pick<LegalworkSessionSnapshot, "messages"> | null | undefined, running: boolean): UIMessage[] {
  if (!running) return messages;
  const lastUser = messages.findLastIndex(message => message.role === "user");
  const completed = new Set(snapshot?.messages.filter(message => message.info.role === "assistant" && (message.info.time.completed || message.info.error)).map(message => message.info.id));
  return messages.flatMap((message, index) => {
    if (message.role !== "assistant" || index < lastUser || completed.has(message.id) || messageCompleted(message)) return [message];
    const parts = message.parts.filter(part => part.type !== "text" && part.type !== "reasoning");
    return parts.length ? [{ ...message, parts }] : [];
  });
}


function messageCompleted(message: UIMessage) {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || !("opencode" in metadata)) return false;
  const info = metadata.opencode;
  return !!info && typeof info === "object" && "completed" in info && info.completed === true;
}
