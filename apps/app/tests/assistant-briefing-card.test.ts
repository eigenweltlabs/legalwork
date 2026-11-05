import { expect, test } from "bun:test";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { assistantChatMessages } from "../src/components/chat/assistant-chat-presentation";
import { isScheduledTaskTool } from "../src/components/chat/scheduled-task-card";

test("only an explicitly created briefing becomes a scheduled-task card", () => {
  for (const action of ["status", "offer", "decline", "create"]) {
    const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "legalwork_assistant_briefing", toolCallId: action, state: "output-available", input: { action }, output: { ok: true } };
    const message: UIMessage = { id: action, role: "assistant", parts: [part] };
    expect(isScheduledTaskTool(part)).toBe(action === "create");
    expect(assistantChatMessages([message])).toHaveLength(action === "create" ? 1 : 0);
  }
  const scratchpad: DynamicToolUIPart = { type: "dynamic-tool", toolName: "legalwork_assistant_scratchpad", toolCallId: "pad", state: "output-available", input: { text: "Watch for the signature" }, output: { ok: true } };
  expect(assistantChatMessages([{ id: "pad", role: "assistant", parts: [scratchpad] }])).toEqual([]);
});
