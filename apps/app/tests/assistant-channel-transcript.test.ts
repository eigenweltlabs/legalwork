import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { mergeAssistantChannelHistory, isChannelHistoryMessage } from "../src/react-app/domains/session/surface/assistant-channel-transcript";
import type { AssistantChannelHistory } from "@legalwork/types/main-assistant";
import { channelHistoryBatch, withChannelHistory } from "../src/react-app/domains/session/surface/assistant-history-window";

const humanId = "00000000-0000-4000-8000-000000000001";
const replyId = "00000000-0000-4000-8000-000000000002";
const history: AssistantChannelHistory = { messages: [
  { id: humanId, actor: "user", channel: "ios", text: "Mobile question", attachments: [], createdAt: "2026-10-09T08:00:00.000Z" },
  { id: replyId, actor: "assistant", channel: "ios", text: "Cloud answer", attachments: [], createdAt: "2026-10-09T08:00:01.000Z" },
], reactions: [{ messageId: humanId, emoji: "👍" }], typing: false };

test("cloud-only days paginate in both directions without losing messages", () => {
  const cloud = { ...history, reactions: [], messages: Array.from({ length: 310 }, (_, index) => ({ ...history.messages[0], id: String(index), createdAt: new Date(index * 1000).toISOString() })) };
  const last = channelHistoryBatch(cloud, "channel-day:2026-10-09", "2026-10-09");
  expect(last.messages).toHaveLength(140);
  expect(last.messages.at(-1)?.id).toBe("channel:309");
  const middle = channelHistoryBatch(cloud, last.sessionId!, last.date!, last.olderCursor);
  const first = channelHistoryBatch(cloud, last.sessionId!, last.date!, middle.olderCursor);
  expect(new Set([...first.messages, ...middle.messages, ...last.messages].map(message => message.id)).size).toBe(310);
  expect(first.olderCursor).toBeUndefined();
  expect(channelHistoryBatch(cloud, last.sessionId!, last.date!, first.newerCursor).messages[0].id).toBe("channel:140");
});

test("historical native pages merge adjacent cloud messages, not the current day's tail", () => {
  const message = (id: string, time: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: id }], metadata: { opencode: { created: Date.parse(time) } } });
  const old = { count: 1, newerCursor: "newer", messages: [message("old", "2026-10-09T07:00:00.000Z")] };
  const adjacent = { count: 1, messages: [message("next", "2026-10-09T09:00:00.000Z")] };
  const cloud = { ...history, reactions: [], messages: [...history.messages, { ...history.messages[0], id: "later", createdAt: "2026-10-09T12:00:00.000Z" }] };
  expect(withChannelHistory(old, cloud, adjacent, "older").messages.map(message => message.id)).toEqual(["old", `channel:${humanId}`, `channel:${replyId}`]);
});

test("cloud projection merges by time without changing native transcript or dispatching prompts", () => {
  const local: UIMessage = { id: "msg_local", role: "user", metadata: { opencode: { created: Date.parse("2026-10-09T08:00:02.000Z") } }, parts: [{ type: "text", text: "Local follow-up" }] };
  const native = [local];
  const merged = mergeAssistantChannelHistory(native, history);
  expect(merged.map(message => message.id)).toEqual([`channel:${humanId}`, `channel:${replyId}`, "msg_local", `channel-reaction:${humanId}`]);
  expect(native).toEqual([local]); expect(native).toHaveLength(1);
  expect(isChannelHistoryMessage(merged[0])).toBe(true); expect(isChannelHistoryMessage(local)).toBe(false);
  expect(mergeAssistantChannelHistory(native, history)).toEqual(merged);
});

test("a locally published echo keeps its native engine ID and reactions reference that bubble", () => {
  const local: UIMessage = { id: "msg_local", role: "user", parts: [{ type: "text", text: "Mobile question" }] };
  const echo = { ...history, messages: [{ ...history.messages[0], localMessageId: "msg_local" }] };
  const merged = mergeAssistantChannelHistory([local], echo);
  expect(merged.filter(message => message.role === "user")).toEqual([local]);
  const reaction = merged.at(-1)?.parts[0];
  expect(reaction?.type === "dynamic-tool" && reaction.output).toEqual({ ok: true, reaction: { messageId: "msg_local", emoji: "👍" } });
});
