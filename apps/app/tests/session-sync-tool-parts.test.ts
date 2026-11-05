import { afterEach, describe, expect, test } from "bun:test";
import type { Part } from "../src/app/lib/opencode-view";
import { projectMessage,projectSession } from "../src/app/lib/opencode-view";
import { createClient } from "../src/app/lib/opencode";
import type { UIMessage } from "ai";
import type { LegalworkSessionSnapshot } from "../src/app/lib/legalwork-server";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import { parseScheduledRunMessage } from "../src/react-app/domains/scheduled-tasks/scheduled-message";

import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { getAssistantRenderGroups, groupMessages, isCompactionMessage } from "../src/components/chat/utils";
import { parseAssistantNameResult } from "../src/components/chat/assistant-name-card";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  trackWorkspaceSessionSync,
  transcriptKey,
  statusKey,
  snapshotKey,
  seedSessionState,
} from "../src/react-app/domains/session/sync/session-sync";
import {
  parseDynamicToolUIPart,
  parseStructuredOutputUIPart,
} from "../src/react-app/domains/session/sync/parse-tool-parts";

afterEach(() => {
  getReactQueryClient().clear();
});

test("scheduled task identity survives live delivery and snapshot reload", async () => {
  const input = { workspaceId: "scheduled-project", baseUrl: "http://127.0.0.1:1234", legalworkToken: "token" };
  const sessionId = "scheduled-chat";
  const metadata = { taskId: "101ec043-4ef0-4df7-88b6-4690869e8830", workspaceId: input.workspaceId, title: "Recordings [daily]" };
  const part: Extract<Part, { type: "text" }> = {
    id: "run-text", messageID: "run", sessionID: sessionId, type: "text", text: `[Scheduled task: ${metadata.title}]\n\nRead yesterday's recordings`,
    metadata: { legalworkScheduledTask: metadata },
  };
  const native={id:"run",type:"user" as const,time:{created:1},text:part.text,metadata:part.metadata};
  const session=projectSession({id:sessionId,title:"Scheduled",projectID:"project",location:{directory:"/fixture"},cost:0,tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}},time:{created:1,updated:2}});
  const snapshot:LegalworkSessionSnapshot={session,messages:projectMessage(sessionId,native),todos:[],status:{type:"idle"}};
  const expected = { ...metadata, prompt: "Read yesterday's recordings" };
  expect(parseScheduledRunMessage(snapshotToUIMessages(snapshot)[0])).toEqual(expected);
  const server=Bun.serve({port:0,fetch:()=>Response.json({data:native})});
  const cleanup=__createWorkspaceSessionSyncForTest(input,createClient(server.url.origin));
  const release=trackWorkspaceSessionSync(input,sessionId);
  try {
    getReactQueryClient().setQueryData(snapshotKey(input.workspaceId,sessionId),snapshot);
    __applySessionSyncEventForTest(input,{type:"session.inbox.delivered",id:"event",created:2,data:{sessionID:sessionId,inboxID:"run"}});
    const deadline=Date.now()+1000;
    while(!getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId,sessionId))?.length){if(Date.now()>deadline)throw new Error("Native user admission did not reconcile");await new Promise(resolve=>setTimeout(resolve,5));}
    const messages=getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId,sessionId)) ?? [];
    expect(parseScheduledRunMessage(messages[0])).toEqual(expected);
  }finally{release();cleanup();server.stop(true);}
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
    const compact={id:"internal-summary",type:"compaction" as const,status:"running" as const,reason:"auto" as const,time:{created:1},summary:"Objective: internal handoff"};
    const session=projectSession({id:"summary-session",title:"Summary",projectID:"project",location:{directory:"/fixture"},cost:0,tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}},time:{created:1,updated:1}});
    seedSessionState(input.workspaceId,{session,messages:projectMessage(session.id,compact),todos:[],status:{type:"busy"}});
    __applySessionSyncEventForTest(input,{type:"session.compaction.started",id:"event",created:1,data:{sessionID:session.id,reason:"auto"}});
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
      const event = (type: string, data: object) => __applySessionSyncEventForTest(input, { type, id: "event", created: 1,
        durable: { aggregateID: part.sessionID, seq: "1", version: 1 }, data: { sessionID: part.sessionID, assistantMessageID: part.messageID, ...data } });
      event("session.step.started", {});
      event("session.tool.input.started", { id: part.callID, name: part.tool });
      event("session.tool.called", { id: part.callID, input: part.state.input });
      event("session.tool.success", { id: part.callID, content: [{ type: "text", text: output }], metadata: {} });
      const messages = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, part.sessionID)) ?? [];
      expect(messages[0]?.parts).toMatchObject([{ type: "dynamic-tool", toolName: part.tool, state: "output-available" }]);
      const live = messages[0]?.parts[0];
      expect(parseAssistantNameResult(live && "output" in live ? live.output : undefined)).toEqual(result);
      expect(getAssistantRenderGroups(messages[0]?.parts ?? [], false)[0]?.kind).toBe("assistant-name");
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
      __applySessionSyncEventForTest(syncInput,{type:"session.step.started",id:"event",created:1,data:{sessionID:"session-a",assistantMessageID:"msg-a",agent:"legalwork",model:{providerID:"fixture",id:"fixture"},started:1}});
      __applySessionSyncEventForTest(syncInput,{type:"session.tool.input.started",id:"event",created:1,data:{sessionID:"session-a",assistantMessageID:"msg-a",id:"tool",name:"write"}});
      let transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[0]?.parts ?? []).toEqual([]);

      __applySessionSyncEventForTest(syncInput,{type:"session.tool.called",id:"event",created:1,data:{sessionID:"session-a",assistantMessageID:"msg-a",id:"tool",input:{content:"hello",filePath:"src/main.ts"},executed:true}});

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
    __applySessionSyncEventForTest(syncInput, { type: "session.idle",id:"event",created:1, data: { sessionID: "session-files" } });
    expect(cache.getQueryState(own)?.isInvalidated).toBe(true);
    expect(cache.getQueryState(other)?.isInvalidated).toBe(false);
  } finally { cleanup(); }
});
