import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";
import type { ToolPart } from "../src/app/lib/opencode-view";
import type { OpenCodeEvent } from "@opencode/client";
import { projectTool } from "../src/app/lib/opencode-view";
import type { WorkspaceSessionGroup } from "../src/app/types";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { SubagentRow } from "../src/components/chat/subagent-tool-row";
import { sessionSubagents, isRunningSubagent } from "../src/react-app/domains/session/surface/session-subagents";
import { subagentDescription, subagentSessionId, subagentStatus } from "../src/components/chat/subagent-tool";
import { getAssistantRenderGroups, groupAssistantToolRuns } from "../src/components/chat/utils";
import { sidebarSessionGroups } from "../src/react-app/domains/session/sidebar/utils";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, trackWorkspaceSessionSync, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";

afterEach(() => getReactQueryClient().clear());

test("the monitor counts running descendants without unrelated, completed or waiting agents", () => {
  const sessions = {
    root: { id: "root", title: "Onboarding" },
    child: { id: "child", title: "Matters", parentID: "root" },
    nested: { id: "nested", title: "Sources", parentID: "child" },
    done: { id: "done", title: "Clients", parentID: "root" },
    waiting: { id: "waiting", title: "Approval", parentID: "root" },
    unrelated: { id: "unrelated", title: "Other", parentID: "other" },
  };
  const agents = sessionSubagents("root", sessions, { child: "responding", nested: "thinking", done: "idle", waiting: "thinking", unrelated: "responding" }, ["waiting"]);
  expect(agents.map(agent => agent.id)).toEqual(["child", "nested", "done", "waiting"]);
  expect(agents.filter(agent => isRunningSubagent(agent.status))).toHaveLength(2);
  expect(sessionSubagents("missing", sessions, {})).toEqual([]);
});

const taskInput = { description: "Review liability clauses", prompt: "Private instructions", subagent_type: "general" };
const task: DynamicToolUIPart = {
  type: "dynamic-tool", toolName: "task", toolCallId: "delegate-1", state: "input-available",
  input: taskInput,
  callProviderMetadata: { opencode: { sessionId: "child-1" } },
};

test("the sidebar hides every descendant, including orphans and archived agents, without changing navigation data", () => {
  const groups: WorkspaceSessionGroup[] = [{
    workspace: { id: "subagent-tests", name: "Project", path: "/project" }, status: "ready",
    sessions: [
      { id: "parent", title: "Review" },
      { id: "child", parentID: "parent", title: "Research", status: "busy" },
      { id: "nested", parentID: "child", title: "References" },
      { id: "orphan", parentID: "unloaded-parent" },
      { id: "archived-agent", parentID: "parent", time: { archived: 1 } },
      { id: "archived-chat", time: { archived: 1 } },
    ],
  }];
  expect(sidebarSessionGroups(groups)[0].sessions.map(session => session.id)).toEqual(["parent", "archived-chat"]);
  expect(groups[0].sessions).toHaveLength(6);
});

test("subagents render outside the main work dropdown, preserving delegation and prose order across engine messages", () => {
  const bash: DynamicToolUIPart = { ...task, toolName: "bash", toolCallId: "shell", input: { command: "private command" } };
  const second: DynamicToolUIPart = { ...task, toolCallId: "delegate-2", callProviderMetadata: { opencode: { sessionId: "child-2" } } };
  const items = [bash, task, second, bash, { type: "text", text: "The review is ready." } satisfies UIMessage["parts"][number]]
    .map((part, index) => ({ index, message: { id: `message-${index}`, role: "assistant", parts: [part] } satisfies UIMessage }));
  for (const showThinking of [false, true]) {
    const groups = groupAssistantToolRuns(items, showThinking).flatMap(item => getAssistantRenderGroups(item.message.parts, showThinking));
    expect(groups.map(group => group.kind)).toEqual(["tools", "subagents", "tools", "text"]);
    expect(groups[1]).toEqual({ kind: "subagents", parts: [task, second] });
    expect(groups.filter(group => group.kind === "tools").flatMap(group => group.parts)).toEqual([bash, bash]);
  }
  expect(items[1].message.parts).toEqual([task]);
});

test("each row exposes its task and status as a native chat-opening button without a dropdown", () => {
  const html = renderToStaticMarkup(<SubagentRow title="Review liability clauses" status="idle" onOpen={() => {}} />);
  expect(html).toMatch(/^<button\b/);
  expect(html).toContain("Open subagent chat: Review liability clauses");
  expect(html).toContain("Started subagent Review liability clauses");
  expect(html).toContain('aria-label="Completed"');
  expect(html).not.toContain(">Completed<");
  expect(html).not.toContain("aria-expanded=");
  expect(html).not.toContain("Private instructions");
  const starting = renderToStaticMarkup(<SubagentRow title="Research" status="thinking" />);
  expect(starting).toContain('aria-label="Thinking"');
  expect(starting).toContain("disabled");
});

test("rows use authoritative session ids and useful descriptions, including streamed and resumed task input", () => {
  expect(subagentSessionId(task)).toBe("child-1");
  expect(subagentDescription(task)).toBe("Review liability clauses");
  expect(subagentSessionId({ ...task, callProviderMetadata: undefined, input: { task_id: "resumed-child" } })).toBe("resumed-child");
  expect(subagentSessionId({ ...task, callProviderMetadata: undefined, input: { description: "child-2" } })).toBeUndefined();
  expect(subagentDescription({ ...task, input: {} })).toBeUndefined();
});

test("waiting and failed agents remain distinct, and a background launch does not count as completion", () => {
  const completed: DynamicToolUIPart = { ...task, state: "output-available", output: "Finished" };
  expect(subagentStatus(task, undefined, false)).toBe("thinking");
  expect(subagentStatus(completed, undefined, false)).toBe("idle");
  expect(subagentStatus(completed, "responding", false)).toBe("responding");
  expect(subagentStatus(completed, "idle", true)).toBe("waiting");
  expect(subagentStatus({ ...task, state: "output-error", errorText: "Interrupted" }, "idle", false)).toBe("error");
  expect(subagentStatus({ ...completed, callProviderMetadata: { opencode: { sessionId: "child-1", background: true } } }, undefined, false)).toBe("thinking");
});

test("native v2 subagent launches show clickable child rows and stay running after background admission", () => {
  for (const background of [false, true]) {
    const part = parseDynamicToolUIPart(projectTool("parent", "assistant", {
      type: "tool", name: "subagent", id: "native-child", time: { created: 1, ran: 1, completed: 2 },
      state: { status: "completed", input: { agent: "general", description: "Create a Word file", background },
        content: [{ type: "text", text: background ? "Working in the background" : "Finished" }],
        metadata: { sessionID: "child-v2", status: background ? "running" : "completed" } },
    }));
    if (!part) throw new Error("Missing native subagent part");
    expect(getAssistantRenderGroups([part], false)).toEqual([{ kind: "subagents", parts: [part] }]);
    expect(subagentSessionId(part)).toBe("child-v2");
    expect(subagentDescription(part)).toBe("Create a Word file");
    expect(subagentStatus(part, undefined, false)).toBe(background ? "thinking" : "idle");
  }
  const resumed = parseDynamicToolUIPart({
    type: "tool", id: "resume", callID: "resume", messageID: "assistant", sessionID: "parent", tool: "subagent",
    state: { status: "running", input: { sessionID: "resumed-child" }, time: { start: 1 } },
  });
  expect(resumed && subagentSessionId(resumed)).toBe("resumed-child");
});

test("session ids survive both the tool mapper and live updates, so rows can open the child before and after completion", () => {
  const input = { workspaceId: "inline-agent-tests", baseUrl: "http://127.0.0.1:1", legalworkToken: "fixture" };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, "parent");
  const running: ToolPart = {
    type: "tool", id: "part-delegate", callID: "delegate-1", messageID: "assistant", sessionID: "parent", tool: "task",
    state: { status: "running", input: taskInput, metadata: { sessionId: "child-1" }, time: { start: 1 } },
  };
  const completed: ToolPart = { ...running, state: { status: "completed", input: taskInput, metadata: { sessionId: "child-1" }, time: { start: 1, end: 2 }, title: "Research", output: "Done" } };
  try {
    for (const part of [running, completed]) {
      const mapped = parseDynamicToolUIPart(part)!;
      expect(subagentSessionId(mapped)).toBe("child-1");
      const common = { id: "event", created: 1, location: { directory: "/fixture" }, durable: { aggregateID: "parent", seq: 1, version: 1 } };
      const emit = (event: OpenCodeEvent) => __applySessionSyncEventForTest(input, event);
      if (part.state.status === "running") {
        emit({ ...common, type: "session.step.started", data: { sessionID: "parent", assistantMessageID: "assistant", agent: "legalwork", model: { providerID: "fixture", id: "model" }, started: 1 } });
        emit({ ...common, type: "session.tool.input.started", data: { sessionID: "parent", assistantMessageID: "assistant", id: part.callID, name: part.tool } });
        emit({ ...common, type: "session.tool.called", data: { sessionID: "parent", assistantMessageID: "assistant", id: part.callID, input: part.state.input, executed: true } });
        emit({ ...common, type: "session.tool.progress", data: { sessionID: "parent", assistantMessageID: "assistant", id: part.callID, metadata: part.state.metadata } });
      } else if (part.state.status === "completed") {
        emit({ ...common, durable: { ...common.durable, version: 2 }, type: "session.tool.success", data: { sessionID: "parent", assistantMessageID: "assistant", id: part.callID, content: [{ type: "text", text: part.state.output }], metadata: part.state.metadata, executed: true } });
      }
      const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "parent")) ?? [];
      const livePart = transcript[0].parts.find(part => part.type === "dynamic-tool");
      expect(livePart && subagentSessionId(livePart)).toBe("child-1");
    }
  } finally { release(); dispose(); }
});
