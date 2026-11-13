import type { UIMessage } from "ai";
import type { SessionHistoryPage } from "@/app/lib/legalwork-server";

export const HISTORY_BATCH_SIZE = 140;
export const HISTORY_BATCH_COUNT = 3;

export type HistoryBatch = SessionHistoryPage & { messages: UIMessage[]; sessionId?: string; date?: string; startReached?: boolean };

export function nearbyHistoryBatches(batches: HistoryBatch[], next: HistoryBatch, direction: "older" | "newer") {
  return direction === "older"
    ? [next, ...batches].slice(0, HISTORY_BATCH_COUNT)
    : [...batches, next].slice(-HISTORY_BATCH_COUNT);
}

export function historyBatchMessages(batches: HistoryBatch[], live: UIMessage[]) {
  const updates = new Map(live.map(message => [message.id, message]));
  const seen = new Set<string>();
  return batches.flatMap(batch => batch.messages).flatMap(message => {
    if (seen.has(message.id)) return [];
    seen.add(message.id);
    return [updates.get(message.id) ?? message];
  });
}

export function recentMessages<T>(messages: T[]) {
  return messages.length > HISTORY_BATCH_SIZE ? messages.slice(-HISTORY_BATCH_SIZE) : messages;
}

// IDs survive eviction; array indexes do not. Used by send/voice tracking.
export function messagesAfter(messages: UIMessage[], baseline: string) {
  return messages.slice(messages.findIndex(message => message.id === baseline) + 1);
}

export type HistoryAnchor = { id: string; top: number };

export function captureHistoryAnchor(container: HTMLElement, retained: Set<string>): HistoryAnchor | null {
  const bounds = container.getBoundingClientRect();
  for (const element of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const id = element.dataset.messageId;
    const rect = element.getBoundingClientRect();
    if (id && retained.has(id) && rect.bottom > bounds.top && rect.top < bounds.bottom) return { id, top: rect.top - bounds.top };
  }
  return null;
}

export function restoreHistoryAnchor(container: HTMLElement, anchor: HistoryAnchor) {
  const element = [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find(node => node.dataset.messageId === anchor.id);
  if (element) container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.top;
}
