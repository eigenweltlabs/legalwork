import { afterEach, describe, expect, test } from "bun:test";
import type { Part } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";

import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { getAssistantRenderGroups, groupMessages, isCompactionMessage } from "../src/components/chat/utils";
import { parseAssistantNameResult } from "../src/components/chat/assistant-name-card";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  trackWorkspaceSessionSync,
  transcriptKey,
  statusKey,
} from "../src/react-app/domains/session/sync/session-sync";
import {
  parseDynamicToolUIPart,
  parseStructuredOutputUIPart,
} from "../src/react-app/domains/session/sync/parse-tool-parts";

afterEach(() => {
  getReactQueryClient().clear();
});

test("compaction summaries stay out of the rendered conversation", () => {
  const summary: UIMessage = { id: "summary", role: "assistant", metadata: { opencode: { summary: true } }, parts: [{ type: "text", text: "Objective and internal tool IDs" }] };
  const answer: UIMessage = { id: "answer", role: "assistant", parts: [{ type: "text", text: "The report is saved." }] };
  expect(isCompactionMessage(summary)).toBe(true);
  expect(groupMessages([summary, answer], "ready")).toEqual([{ messages: [{ index: 1, message: answer }] }]);
  expect(groupMessages([summary], "ready")).toEqual([]);
});

test("live compaction metadata hides internal text without marking the agent idle", () => {
  const input = { workspaceId: "summary-project", baseUrl: "http://127.0.0.1:1234", legalworkToken: "token" };
  const cleanup = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, "summary-session");
  const cache = getReactQueryClient();
  cache.setQueryData(statusKey(input.workspaceId, "summary-session"), { type: "busy" });
  try {
    __applySessionSyncEventForTest(input, { type: "message.updated", properties: { info: {
      id: "internal-summary", role: "assistant", sessionID: "summary-session", summary: true,
      finish: "stop", time: { created: 1, completed: 2 },
    } } });
    __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part: {
      id: "summary-text", messageID: "internal-summary", sessionID: "summary-session", type: "text", text: "Objective: internal handoff",
    } } });
    const transcript = cache.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "summary-session")) ?? [];
    expect(isCompactionMessage(transcript[0])).toBe(true);
    expect(groupMessages(transcript, "ready")).toEqual([]);
    expect(cache.getQueryData(statusKey(input.workspaceId, "summary-session"))).toEqual({ type: "busy" });
  } finally { release(); cleanup(); }
});

function writeToolPart(
  status: "pending" | "running" | "completed" | "error",
  input: Record<string, unknown>,
  overrides: Partial<Extract<Part, { type: "tool" }>> = {},
): Extract<Part, { type: "tool" }> {
  const base = {
    id: "part-write",
    sessionID: "session-a",
    messageID: "msg-a",
    type: "tool" as const,
    callID: "call-write",
    tool: "write",
  };

  if (status === "completed") {
    return {
      ...base,
      ...overrides,
      state: {
        status: "completed",
        input,
        output: "ok",
        title: "Write",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
  }

  if (status === "error") {
    return {
      ...base,
      ...overrides,
      state: {
        status: "error",
        input,
        error: "failed",
        time: { start: 1, end: 2 },
      },
    };
  }

  if (status === "running") {
    return {
      ...base,
      ...overrides,
      state: {
        status: "running",
        input,
        time: { start: 1 },
      },
    };
  }

  return {
    ...base,
    ...overrides,
    state: {
      status: "pending",
      input,
      raw: "",
    },
  };
}

describe("tool part mapper", () => {
  test("defers in-progress tools with empty input", () => {
    // shouldDeferInProgressTool left with the legacy message list (#2016);
    // the deferral behavior itself is still pinned here via the parser and
    // end-to-end below via session sync.
    expect(parseDynamicToolUIPart(writeToolPart("pending", {}))).toBeNull();
    expect(parseDynamicToolUIPart(writeToolPart("running", {}))).toBeNull();
  });

  test("maps in-progress tools with partial input as input-streaming", () => {
    const part = writeToolPart("running", { content: "hello" });
    expect(parseDynamicToolUIPart(part)).toMatchObject({
      type: "dynamic-tool",
      toolName: "write",
      state: "input-streaming",
      input: { content: "hello" },
    });
  });

  test("maps completed tools", () => {
    const part = writeToolPart("completed", { content: "hello", filePath: "src/a.ts" });
    expect(parseDynamicToolUIPart(part)).toMatchObject({
      state: "output-available",
      input: { content: "hello", filePath: "src/a.ts" },
      output: "ok",
    });
  });

  test("naming widgets survive appended app-state reminders in saved and live tool results", () => {
    const result = { ok: true, showAvatarPicker: true, onboarding: { needed: true, greetingUnread: false, step: "avatar", sessionId: "session-a", name: "Johann", icon: "dot", agentNamed: true } };
    const output = JSON.stringify(result) + '\n\n<system-reminder topic="main-assistant">\nSetup stage: avatar.\n</system-reminder>\n\n<system-reminder topic="project">\nCurrent project metadata.\n</system-reminder>';
    const part = writeToolPart("completed", { name: "Johann" }, { tool: "legalwork_assistant_set_name" });
    if (part.state.status !== "completed") throw new Error("Expected a completed tool");
    part.state.output = output;
    const mapped = parseDynamicToolUIPart(part);
    expect(mapped?.state).toBe("output-available");
    expect(parseAssistantNameResult(mapped?.output)).toEqual(result);
    expect(part.state.output).toBe(output); // Model history keeps its reminders.
    expect(getAssistantRenderGroups(mapped ? [mapped] : [], false)[0]?.kind).toBe("assistant-name");

    const input = { workspaceId: "naming-project", baseUrl: "http://127.0.0.1:1234", legalworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const release = trackWorkspaceSessionSync(input, part.sessionID);
    try {
      __applySessionSyncEventForTest(input, { type: "message.updated", properties: { info: { id: part.messageID, role: "assistant", sessionID: part.sessionID } } });
      __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part } });
      const messages = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, part.sessionID)) ?? [];
      expect(messages[0]?.parts).toEqual([mapped]);
    } finally { release(); cleanup(); }
  });

  test("only trailing app reminders after valid JSON are removed from widget output", () => {
    const reminder = '\n\n<system-reminder topic="project">\nCurrent project.\n</system-reminder>';
    for (const output of ['not JSON' + reminder, '{broken' + reminder, '{"ok":true}' + reminder + '\nUser-facing result', JSON.stringify({ text: reminder })]) {
      const part = writeToolPart("completed", {});
      if (part.state.status !== "completed") throw new Error("Expected a completed tool");
      part.state.output = output;
      expect(parseDynamicToolUIPart(part)?.output).toBe(output);
    }
  });

  test("maps env var request tools for rich chat rendering", () => {
    const part = writeToolPart("running", { key: "NOTION_TOKEN" }, { tool: "request_env_var" });
    expect(parseDynamicToolUIPart(part)).toMatchObject({
      type: "dynamic-tool",
      toolName: "request_env_var",
      input: { key: "NOTION_TOKEN" },
    });
  });

  test("skips empty structured output while streaming", () => {
    const part = writeToolPart("running", {}, { tool: "StructuredOutput" });
    expect(parseStructuredOutputUIPart(part)).toBeNull();
    expect(Object.keys(part.state.input).length).toBe(0);
  });

  test("keeps completed structured output even when input is {}", () => {
    const part = writeToolPart("completed", {}, { tool: "StructuredOutput" });
    expect(parseStructuredOutputUIPart(part)).toMatchObject({
      type: "text",
      text: "{}",
      state: "done",
    });
  });

  test("session sync defers empty in-progress write tools until input arrives", () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", legalworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-a", role: "assistant", sessionID: "session-a" } },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: { part: writeToolPart("pending", {}) },
      } as any);

      let transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[0]?.parts ?? []).toEqual([]);

      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: writeToolPart("running", { content: "hello", filePath: "src/main.ts" }),
        },
      } as any);

      transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[0]?.parts[0]).toMatchObject({
        type: "dynamic-tool",
        toolName: "write",
        state: "input-streaming",
        input: { content: "hello", filePath: "src/main.ts" },
      });
    } finally {
      release();
      cleanup();
    }
  });
});

test("finishing an agent run refreshes its project file list without invalidating another project", () => {
  const syncInput = { workspaceId: "workspace-files-a", baseUrl: "http://127.0.0.1:1234", legalworkToken: "token" };
  const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
  const cache = getReactQueryClient();
  const own = ["workspace-files", syncInput.workspaceId, "reports"];
  const other = ["workspace-files", "workspace-files-b", "reports"];
  cache.setQueryData(own, { entries: [] }); cache.setQueryData(other, { entries: [] });
  try {
    __applySessionSyncEventForTest(syncInput, { type: "session.idle", properties: { sessionID: "session-files" } });
    expect(cache.getQueryState(own)?.isInvalidated).toBe(true);
    expect(cache.getQueryState(other)?.isInvalidated).toBe(false);
  } finally { cleanup(); }
});
