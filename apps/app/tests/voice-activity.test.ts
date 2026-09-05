import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { collectVoiceActivity } from "@/react-app/domains/session/voice/voice-activity";

function message(parts: UIMessage["parts"]): UIMessage {
  return { id: crypto.randomUUID(), role: "assistant", parts };
}

describe("collectVoiceActivity", () => {
  test("keeps only structured, human-readable task activity", () => {
    const activity = collectVoiceActivity([
      message([
        { type: "reasoning", text: "private reasoning" },
        {
          type: "dynamic-tool",
          toolName: "read",
          toolCallId: "read-1",
          state: "input-streaming",
          input: { filePath: "/workspace/server.log" },
        },
      ]),
    ]);

    expect(activity).toEqual([{
      id: "read-1",
      label: "Reading server.log",
      state: "active",
    }]);
  });

  test("updates an existing activity instead of duplicating streamed tool events", () => {
    const activity = collectVoiceActivity([
      message([{
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "read-1",
        state: "input-streaming",
        input: { filePath: "/workspace/contract.pdf" },
      }]),
      message([{
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "read-1",
        state: "output-available",
        input: { filePath: "/workspace/contract.pdf" },
        output: "done",
      }]),
    ]);

    expect(activity).toEqual([{
      id: "read-1",
      label: "Reading contract.pdf",
      state: "complete",
    }]);
  });

  test("uses LegalMemory's user-facing activity language", () => {
    const activity = collectVoiceActivity([
      message([{
        type: "dynamic-tool",
        toolName: "legalmemory_search_semantic",
        toolCallId: "memory-1",
        state: "input-available",
        input: { query: "change of control" },
      }]),
    ]);

    expect(activity).toEqual([{
      id: "memory-1",
      label: "Searching firm knowledge for “change of control”",
      state: "active",
    }]);
  });

  test("limits the trail to the latest activities", () => {
    const messages = Array.from({ length: 8 }, (_, index) => message([{
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: `call-${index}`,
      state: "output-available",
      input: { command: "true", description: `Step ${index}` },
      output: "",
    }]));

    expect(collectVoiceActivity(messages, 3).map((item) => item.id)).toEqual([
      "call-5",
      "call-6",
      "call-7",
    ]);
  });
});
