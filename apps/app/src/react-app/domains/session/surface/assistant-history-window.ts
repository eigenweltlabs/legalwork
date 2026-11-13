import type { AssistantChannelHistory } from "@legalwork/types/main-assistant";
import type { UIMessage } from "ai";
import { mergeAssistantChannelHistory } from "./assistant-channel-transcript";
import { HISTORY_BATCH_SIZE, type HistoryBatch } from "./history-window";

/** Cloud-only days have no native session to request. Page their display projection locally. */
export function channelHistoryBatch(history: AssistantChannelHistory, sessionId: string, date: string, cursor?: string, order: "asc" | "desc" = "desc"): HistoryBatch {
  const messages = mergeAssistantChannelHistory([], history);
  const start = cursor ? Number(cursor.replace(/^channel:/, "")) : order === "asc" ? 0 : Math.max(0, messages.length - HISTORY_BATCH_SIZE);
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("Invalid channel history cursor");
  const end = start + HISTORY_BATCH_SIZE;
  return { sessionId, date, order, messages: messages.slice(start, end), count: messages.slice(start, end).length,
    olderCursor: start > 0 ? `channel:${Math.max(0, start - HISTORY_BATCH_SIZE)}` : undefined,
    newerCursor: end < messages.length ? `channel:${end}` : undefined };
}

function created(message: UIMessage): number | undefined {
  const metadata = message.metadata;
  const info = metadata && typeof metadata === "object" && "opencode" in metadata ? metadata.opencode : null;
  return info && typeof info === "object" && "created" in info && typeof info.created === "number" ? info.created : undefined;
}

/** Keep cloud entries alongside their native page, without injecting today's tail into older pages. */
export function withChannelHistory(batch: HistoryBatch, history: AssistantChannelHistory, adjacent?: HistoryBatch, direction?: "older" | "newer"): HistoryBatch {
  const times = batch.messages.flatMap(message => { const time = created(message); return time === undefined ? [] : [time]; });
  const adjacentTimes = adjacent?.messages.flatMap(message => { const time = created(message); return time === undefined ? [] : [time]; }) ?? [];
  const lower = direction === "newer" && adjacentTimes.length ? Math.max(...adjacentTimes) : batch.olderCursor && times.length ? Math.min(...times) : -Infinity;
  const upper = direction === "older" && adjacentTimes.length ? Math.min(...adjacentTimes) : direction && batch.newerCursor && times.length ? Math.max(...times) : Infinity;
  const messages = mergeAssistantChannelHistory(batch.messages, { ...history, messages: history.messages.filter(message => {
    const time = Date.parse(message.desktop?.createdAt ?? message.createdAt);
    return time >= lower && time <= upper;
  }) });
  return { ...batch, messages };
}
