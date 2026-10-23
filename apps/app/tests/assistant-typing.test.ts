import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { Part } from "@opencode-ai/sdk/v2/client";
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

test("real text start/end events drive typing independently of reasoning, delegation and complete-bubble buffering", () => {
  const input = { workspaceId: "typing-project", baseUrl: "http://127.0.0.1:1", legalworkToken: "test" };
  const sessionId = "typing-session";
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, sessionId);
  const query = getReactQueryClient();
  const info = { id: "reply", sessionID: sessionId, role: "assistant", parentID: "user", modelID: "model", providerID: "provider", mode: "legalwork", agent: "legalwork", path: { cwd: "/matter", root: "/matter" }, time: { created: 1 }, cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } satisfies LegalworkSessionSnapshot["messages"][number]["info"];
  const text = { id: "ack", sessionID: sessionId, messageID: info.id, type: "text", text: "", time: { start: 2 } } satisfies Part;
  const transcript = () => query.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, sessionId)) ?? [];
  const update = (part: Part) => __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part } });
  try {
    __applySessionSyncEventForTest(input, { type: "message.updated", properties: { info } });
    update({ ...text, id: "reasoning", type: "reasoning", text: "Find the correct project" });
    expect(assistantTextIsStreaming(transcript())).toBe(false);
    update(text);
    expect(assistantTextIsStreaming(transcript())).toBe(false);
    update({ ...text, text: "I will check and follow up." });
    expect(assistantTextIsStreaming(transcript())).toBe(true);
    expect(assistantBubbleMessages(transcript(), null, true)).toEqual([]);
    update({ ...text, text: "I will check and follow up.", time: { start: 2, end: 3 } });
    expect(assistantTextIsStreaming(transcript())).toBe(false);
    expect(assistantBubbleMessages(transcript(), null, true)[0].parts).toHaveLength(1);
    const tool: Part = { id: "delegation", sessionID: sessionId, messageID: info.id, type: "tool", callID: "delegate", tool: "legalwork_assistant_delegate", state: { status: "running", input: { task: "Check replies" }, time: { start: 4 } } };
    update(tool);
    expect(assistantTextIsStreaming(transcript())).toBe(false);
    update({ ...text, id: "result", text: "The results are ready.", time: { start: 5 } });
    expect(assistantTextIsStreaming(transcript())).toBe(true);
    __applySessionSyncEventForTest(input, { type: "message.updated", properties: { info: { ...info, time: { created: 1, completed: 6 } } } });
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
