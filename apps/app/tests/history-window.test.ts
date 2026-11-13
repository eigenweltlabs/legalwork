import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { HISTORY_BATCH_SIZE, HISTORY_BATCH_COUNT, nearbyHistoryBatches, historyBatchMessages, messagesAfter, type HistoryBatch } from "../src/react-app/domains/session/surface/history-window";
import { reconcileTranscriptMessages, resolvePagedForkBoundaryId } from "../src/react-app/domains/session/sync/transcript-reconcile";

function message(index: number): UIMessage {
  return { id: `message-${index}`, role: index % 2 ? "assistant" : "user", parts: [{ type: "text", text: `Synthetic message ${index}` }], metadata: { opencode: { created: index } } };
}

function batch(index: number): HistoryBatch {
  return { count: HISTORY_BATCH_SIZE, olderCursor: `older-${index}`, newerCursor: `newer-${index}`,
    messages: Array.from({ length: HISTORY_BATCH_SIZE }, (_, offset) => message(index * HISTORY_BATCH_SIZE + offset)) };
}

test("ten thousand messages stay reachable in both directions with only three batches retained", () => {
  let pages = [batch(72)];
  for (let index = 71; index >= 0; index--) {
    pages = nearbyHistoryBatches(pages, batch(index), "older");
    const messages = historyBatchMessages(pages, []);
    expect(pages.length).toBeLessThanOrEqual(HISTORY_BATCH_COUNT);
    expect(messages.length).toBeLessThanOrEqual(HISTORY_BATCH_COUNT * HISTORY_BATCH_SIZE);
    expect(messages[0]?.id).toBe(`message-${index * HISTORY_BATCH_SIZE}`);
    expect(pages[0]?.olderCursor).toBe(`older-${index}`);
  }
  for (let index = 3; index <= 72; index++) {
    pages = nearbyHistoryBatches(pages, batch(index), "newer");
    expect(historyBatchMessages(pages, []).map(item => item.id)).toEqual(
      Array.from({ length: 420 }, (_, offset) => `message-${(index - 2) * HISTORY_BATCH_SIZE + offset}`));
    expect(pages.at(-1)?.newerCursor).toBe(`newer-${index}`);
  }
});

test("streaming updates change loaded messages without appending the remote live tail into history", () => {
  const pages = [batch(0)];
  const changed: UIMessage = { ...message(50), parts: [{ type: "text", text: "Updated response" }] };
  const messages = historyBatchMessages(pages, [changed, message(10000)]);
  expect(messages).toHaveLength(140);
  expect(messages[50]?.parts).toEqual(changed.parts);
  expect(messages.some(item => item.id === "message-10000")).toBe(false);
});

test("snapshots and live sends cannot grow the shared transcript cache indefinitely", () => {
  let messages: UIMessage[] = [];
  for (let index = 0; index < 1000; index++) {
    messages = reconcileTranscriptMessages({ currentMessages: messages, snapshotMessages: [message(index)] });
  }
  expect(messages).toHaveLength(140);
  expect(messages[0]?.id).toBe("message-860");
  expect(messages.at(-1)?.id).toBe("message-999");
  expect(messagesAfter(messages, "message-998").map(item => item.id)).toEqual(["message-999"]);
  expect(messagesAfter(messages, "message-0")).toEqual(messages);
});

test("branching at an unloaded batch edge includes only the selected message", async () => {
  const pages = [[], [message(140), message(141)]];
  expect(await resolvePagedForkBoundaryId(batch(0).messages, "message-139", async () => pages.shift() ?? null)).toBe("message-140");
});

test("branching at the actual end still includes the full chat", async () => {
  expect(await resolvePagedForkBoundaryId(batch(0).messages, "message-139", async () => null)).toBeNull();
});

test("branching fails safely when the next batch cannot be read", async () => {
  await expect(resolvePagedForkBoundaryId(batch(0).messages, "message-139", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
});
