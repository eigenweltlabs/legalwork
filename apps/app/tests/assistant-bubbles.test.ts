import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { assistantBubbleMessages } from "../src/react-app/domains/session/surface/assistant-bubbles";

test("Assistant prose stays buffered during generation, tools remain live, and complete messages arrive intact", () => {
  const user: UIMessage = { id: "user", role: "user", parts: [{ type: "text", text: "Check Aster" }] };
  const reply: UIMessage = { id: "reply", role: "assistant", parts: [{ type: "text", text: "I have checked" }] };
  const tool: UIMessage = { id: "tool", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "legalwork_assistant_projects", toolCallId: "call", state: "input-streaming", input: { query: "Aster" } }] };
  const messages = [user, tool, reply];
  expect(assistantBubbleMessages(messages, null, true)).toEqual([user, tool]);
  expect(assistantBubbleMessages(messages, null, false)).toBe(messages);
  const snapshot = { messages: [{ info: { id: "reply", sessionID: "session", role: "assistant", parentID: "user", modelID: "model", providerID: "provider", mode: "legalwork", agent: "legalwork", path: { cwd: "/matter", root: "/matter" }, time: { created: 1, completed: 2 }, cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] }] };
  // A completed message may arrive while another tool/step is still running.
  expect(assistantBubbleMessages(messages, { messages: snapshot.messages.map(message => ({ ...message, info: { ...message.info, role: "assistant" } })) }, true)).toEqual(messages);
  expect(reply.parts[0]).toEqual({ type: "text", text: "I have checked" });
});

test("starting a new turn keeps every historical reply even when the snapshot is missing or partial", () => {
  const previous: UIMessage = { id: "old-reply", role: "assistant", parts: [{ type: "text", text: "Your earlier result" }] };
  const user: UIMessage = { id: "new-user", role: "user", parts: [{ type: "text", text: "Next task" }] };
  const pending: UIMessage = { id: "pending", role: "assistant", parts: [{ type: "text", text: "Incomplete new reply" }] };
  for (const snapshot of [null, { messages: [] }]) {
    expect(assistantBubbleMessages([previous, user], snapshot, true)).toEqual([previous, user]);
    expect(assistantBubbleMessages([previous, user, pending], snapshot, true)).toEqual([previous, user]);
    const completed = { ...pending, metadata: { opencode: { completed: true } } };
    expect(assistantBubbleMessages([previous, user, completed], snapshot, true)).toEqual([previous, user, completed]);
  }
});
