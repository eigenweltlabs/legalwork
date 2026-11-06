import type { UIMessage } from "ai";
import type { LegalworkSessionSnapshot } from "@/app/lib/legalwork-server";

/** Typing describes the current user-facing text part, not the run's busy state.
 * Read the unbuffered transcript: unfinished text is deliberately absent from
 * assistantBubbleMessages until the complete bubble can be displayed. */
export function assistantIsWriting(messages: UIMessage[], snapshot: Pick<LegalworkSessionSnapshot, "messages"> | null | undefined, running: boolean): boolean {
  if (!running) return false;
  const message = messages.at(-1);
  if (!message || message.role !== "assistant" || messageCompleted(message)) return false;
  const source = snapshot?.messages.find(item => item.info.id === message.id);
  if (source?.info.role === "assistant" && (source.info.time.completed || source.info.error)) return false;
  const part = message.parts.at(-1);
  // A subsequent tool call, reasoning part or step ends the typing phase even
  // if the engine has not yet published completion of the preceding text.
  if (part?.type !== "text") return false;
  const metadata = part.providerMetadata?.opencode;
  const original = source?.parts.find(item => item.id === metadata?.partId);
  if (metadata?.textComplete === true || (original?.type === "text" && (original.time?.end || original.synthetic || original.ignored))) return false;
  return part.state === "streaming" || metadata?.textComplete === false || (original?.type === "text" && Boolean(original.time?.start));
}

/** Show complete text bubbles as soon as text ends, even while its tools continue. */
export function assistantBubbleMessages(messages: UIMessage[], snapshot: Pick<LegalworkSessionSnapshot, "messages"> | null | undefined, running: boolean): UIMessage[] {
  if (!running) return messages;
  const lastUser = messages.findLastIndex(message => message.role === "user");
  const completed = new Set(snapshot?.messages.filter(message => message.info.role === "assistant" && (message.info.time.completed || message.info.error)).map(message => message.info.id));
  const settled = new Map(snapshot?.messages.map(message => [message.info.id, new Set(message.parts.flatMap(part => part.type === "text" && part.time?.end ? [part.id] : []))]));
  return messages.flatMap((message, index) => {
    if (message.role !== "assistant" || index < lastUser || completed.has(message.id) || messageCompleted(message)) return [message];
    const parts = message.parts.filter(part => {
      if (part.type === "reasoning") return false;
      if (part.type !== "text") return true;
      const metadata = part.providerMetadata?.opencode;
      return metadata?.textComplete === true || (typeof metadata?.partId === "string" && settled.get(message.id)?.has(metadata.partId));
    });
    return parts.length ? [{ ...message, parts }] : [];
  });
}


function messageCompleted(message: UIMessage) {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || !("opencode" in metadata)) return false;
  const info = metadata.opencode;
  return !!info && typeof info === "object" && "completed" in info && info.completed === true;
}
