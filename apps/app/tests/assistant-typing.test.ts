import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { Part } from "@/app/lib/opencode-view";
import type { LegalworkSessionSnapshot } from "../src/app/lib/legalwork-server";
import { assistantBubbleMessages, assistantTextIsStreaming } from "../src/react-app/domains/session/surface/assistant-bubbles";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, trackWorkspaceSessionSync, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";

const user: UIMessage = { id: "user", role: "user", parts: [{ type: "text", text: "Check the replies" }] };
const reply: UIMessage = { id: "reply", role: "assistant", parts: [{ type: "text", text: "I will check", state: "streaming" }] };

test("only the latest visible text stream counts, never reasoning, tools, prior turns or completed text", () => {
  expect(assistantTextIsStreaming([])).toBe(false);
  expect(assistantTextIsStreaming([user])).toBe(false);
  expect(assistantTextIsStreaming([user, reply])).toBe(true);
  expect(assistantTextIsStreaming([reply, user])).toBe(false);
  expect(assistantTextIsStreaming([user, { ...reply, parts: [] }])).toBe(false);
  expect(assistantTextIsStreaming([user, { ...reply, parts: [{ type: "text", text: "", state: "streaming" }] }])).toBe(false);
  for (const nextPart of [
    { type: "reasoning", text: "Thinking", state: "streaming" },
    { type: "dynamic-tool", toolName: "legalwork_assistant_delegate", toolCallId: "delegate", input: {}, state: "input-streaming" },
    { type: "dynamic-tool", toolName: "legalwork_assistant_delegate", toolCallId: "delegate", input: {}, state: "output-available", output: { ok: true } },
    { type: "step-start" },
  ] satisfies UIMessage["parts"]) {
    expect(assistantTextIsStreaming([user, { ...reply, parts: [...reply.parts, nextPart] }])).toBe(false);
    expect(assistantTextIsStreaming([user, reply, { id: "next", role: "assistant", parts: [nextPart] }])).toBe(false);
  }
  expect(assistantTextIsStreaming([user, { ...reply, metadata: { opencode: { completed: true } } }])).toBe(false);
  expect(assistantTextIsStreaming([user, { ...reply, metadata: { opencode: { summary: true } } }])).toBe(false);
  expect(assistantTextIsStreaming([user, { ...reply, parts: [{ type: "text", text: "Done", state: "streaming", providerMetadata: { opencode: { textComplete: true } } }] }])).toBe(false);
});

test("native text start/end events drive typing independently of reasoning, delegation and complete-bubble buffering", async () => {
  const input = { workspaceId: "typing-project", baseUrl: "http://127.0.0.1:1", legalworkToken: "test" };
  const sessionId = "typing-session";
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, sessionId);
  const query = getReactQueryClient();
  const messageId = "reply";
  const transcript = () => query.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, sessionId)) ?? [];
  const event = (type: string, data: object) => __applySessionSyncEventForTest(input, { id: "event", created: 1, type, durable: { aggregateID: sessionId, seq: "1", version: 1 }, data: { sessionID: sessionId, assistantMessageID: messageId, ...data } });
  try {
    event("session.step.started", {});
    event("session.reasoning.started", { ordinal: 0 });
    event("session.reasoning.ended", { ordinal: 0, text: "Find the correct project" });
    expect(assistantTextIsStreaming(transcript())).toBe(false);
    event("session.text.started", { ordinal: 1 });
    expect(assistantTextIsStreaming(transcript())).toBe(false);
    event("session.text.delta", { ordinal: 1, delta: "I will check and follow up." });
    await Bun.sleep(0);
    expect(assistantTextIsStreaming(transcript())).toBe(true);
    expect(assistantBubbleMessages(transcript(), null, true)).toEqual([]);
    event("session.text.ended", { ordinal: 1, text: "I will check and follow up." });
    expect(assistantTextIsStreaming(transcript())).toBe(false);
    expect(assistantBubbleMessages(transcript(), null, true)[0].parts).toHaveLength(1);
    event("session.tool.input.started", { id: "delegate", name: "legalwork_assistant_delegate" });
    event("session.tool.called", { id: "delegate", input: { task: "Check replies" } });
    expect(assistantTextIsStreaming(transcript())).toBe(false);
    event("session.text.started", { ordinal: 3 });
    event("session.text.delta", { ordinal: 3, delta: "The results are ready." });
    await Bun.sleep(0);
    expect(assistantTextIsStreaming(transcript())).toBe(true);
    event("session.text.ended", { ordinal: 3, text: "The results are ready." });
    expect(assistantTextIsStreaming(transcript())).toBe(false);
  } finally { release(); dispose(); query.clear(); }
});

test("an open snapshot text part can resume typing, while a settled snapshot overrides stale live text", () => {
  const info = { id: "reply", sessionID: "chat", role: "assistant", parentID: "user", modelID: "model", providerID: "provider", mode: "legalwork", agent: "legalwork", path: { cwd: "/matter", root: "/matter" }, time: { created: 1 }, cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } satisfies LegalworkSessionSnapshot["messages"][number]["info"];
  const part: Part = { id: "text", sessionID: "chat", messageID: "reply", type: "text", text: "The result", time: { start: 2 } };
  const snapshot: LegalworkSessionSnapshot = { session: { id: "chat", title: "Replies", version: "1", time: { created: 1, updated: 2 } }, status: { type: "busy" }, todos: [], messages: [{ info, parts: [part] }] };
  const messages = snapshotToUIMessages(snapshot);
  expect(assistantTextIsStreaming(messages, snapshot)).toBe(true);
  expect(assistantTextIsStreaming(messages, { messages: [{ info, parts: [{ ...part, time: { start: 2, end: 3 } }] }] })).toBe(false);
  expect(assistantTextIsStreaming(messages, { messages: [{ info: { ...info, time: { created: 1, completed: 3 } }, parts: [part] }] })).toBe(false);
  for (const hidden of [{ synthetic: true }, { ignored: true }]) {
    expect(assistantTextIsStreaming(snapshotToUIMessages({ ...snapshot, messages: [{ info, parts: [{ ...part, ...hidden }] }] }))).toBe(false);
  }
});
