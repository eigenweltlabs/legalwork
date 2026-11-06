import { afterEach, expect, test } from "bun:test";
import type { SessionMessageAssistantTool, SessionInfo } from "@opencode/client";
import type { UIMessage } from "ai";
import { projectMessages, projectSession, projectTool } from "../src/app/lib/opencode-view";
import { getAssistantRenderGroups } from "../src/components/chat/utils";
import { parseDynamicToolUIParts } from "../src/react-app/domains/session/sync/parse-tool-parts";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, trackWorkspaceSessionSync, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { getToolHistoryLabel, getToolIcon, getToolRunSummary } from "../src/components/tools/tool-presentation";
import { BookOpen, FilePenLine, FilePlus2, FolderSearch, Search, SquareTerminal } from "lucide-react";
import { getToolActivityLabel } from "../src/lib/tool-activity";
import { filedTasksOf } from "../src/components/chat/filed-tasks";
import { collectLegalMemoryDocuments, legalMemoryOutputsOf } from "../src/lib/legalmemory-documents";
import { assistantChatMessages, sharedAssistantFile } from "../src/components/chat/assistant-chat-presentation";
import { parseDelegationCard } from "../src/components/chat/delegation-card";

const id = "101ec043-4ef0-4df7-88b6-4690869e8830";
const common = { id, workspaceId: "workspace", revision: id, path: "draft", updatedAt: 1 };
const preview = { status: "preview", owner: { kind: "workspace", id: "workspace" }, input: { version: 1, title: "Summary", mode: "report", catalog: "legalwork-1", program: 'root = Text("Hello")', queries: {} } };
const cases = [
  { tool: "legalwork_review_start", kind: "review", output: { ok: true, workspaceId: "workspace", review: { id, name: "Contracts", status: "running", completed: 0, total: 2, documents: 2, columns: 1 } } },
  { tool: "legalwork_jev_corpus_question", kind: "jev-search", output: { ok: true, workspaceId: "workspace", data: { jobId: id, status: "running", total: 2, processed: 0, counts: {} } } },
  { tool: "legalwork_calculation_present", kind: "calculation", output: { ok: true, referenceData: { presentation: { id, workspaceId: "workspace", title: "Calculation" } } } },
  { tool: "legalwork_email_draft", kind: "email-draft", output: { draft: { ...common, subject: "Hello" } } },
  { tool: "legalwork_calendar_event_draft", kind: "calendar-event-draft", output: { draft: { ...common, title: "Meeting", sequence: 0, start: "2026-10-27", end: "2026-10-28", startInstant: "2026-10-27T00:00:00Z", endInstant: "2026-10-28T00:00:00Z" } } },
  { tool: "legalwork_schedule_create", kind: "scheduled-task", output: { task: { id, workspaceId: "workspace", revision: 1, title: "Follow-up", prompt: "Review", schedule: { kind: "once", startAt: "2026-10-28T10:00:00Z", timeZone: "Europe/Berlin" }, sessionId: null, status: "active", nextRunAt: null, createdAt: "now", updatedAt: "now" } } },
  { tool: "legalwork_project_list", kind: "project", output: { version: 1, project: { id: "workspace", name: "Matter", fields: [] }, sections: [] } },
  { tool: "wiki_suggest", kind: "wiki-suggestion", output: { suggestion: { id, workspaceId: "workspace", sessionId: "chat", title: "Knowledge", content: "# Knowledge", destination: { wikiId: "wiki", path: "Knowledge.md", baseRevision: null }, status: "pending", createdAt: 1, updatedAt: 1, revision: "r1", filePath: "draft.md" } } },
  { tool: "view_create", kind: "view", output: preview },
  { tool: "legalwork_assistant_share_file", kind: "assistant-file", output: { ok: true, file: { path: "reports/briefing.md", title: "Morning briefing", size: 100, source: { workspaceId: "matter", workspaceRoot: "/fixture/matter", projectName: "Matter" } } } },
  { tool: "legalwork_assistant_delegate", kind: "delegation", output: { ok: true, delegation: { workspaceId: "matter", sessionId: "child", projectName: "Matter", title: "Review agreement", scope: "Review for provider", status: "started" } } },
  { tool: "legalwork_assistant_set_name", kind: "assistant-name", output: { ok: true, showAvatarPicker: true, onboarding: { needed: true, greetingUnread: false, step: "avatar", sessionId: "chat", name: "Maya", icon: "cat", agentNamed: true } } },
];
const session: SessionInfo = { id: "chat", projectID: "project", location: { directory: "/fixture" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } };
function native(tool: string, output: unknown, input: unknown = {}): SessionMessageAssistantTool {
  return { type: "tool", name: "execute", id: "execute-call", time: { created: 1, ran: 1, completed: 2 }, state: {
    status: "completed", input: { code: "return result;" }, content: [{ type: "text", text: JSON.stringify(output) }],
    metadata: { toolCalls: [{ tool, status: "completed", input }] },
  } };
}
function history(tool: SessionMessageAssistantTool) {
  return snapshotToUIMessages({ session: projectSession(session), status: { type: "idle" }, todos: [], messages: projectMessages(session.id, [{
    id: "assistant", type: "assistant", agent: "legalwork", model: { providerID: "fixture", id: "model" }, tokens: session.tokens, cost: 0, time: { created: 1, completed: 2 }, content: [tool],
  }]) })[0].parts;
}

test.each(cases)("native Code Mode restores $kind cards in live projection and saved history", ({ tool, kind, output }) => {
  const source = native(tool, output);
  const original = structuredClone(source);
  for (const parts of [parseDynamicToolUIParts(projectTool(session.id, "assistant", source)), history(source)]) {
    expect(getAssistantRenderGroups(parts, false).map(group => group.kind)).toEqual([kind]);
  }
  expect(source).toEqual(original);
});

test.each(cases)("verified Code Mode $kind cards survive a discarded script result in live and saved chat", ({ tool, kind, output }) => {
  const source = native(tool, "done");
  if (source.state.status !== "completed") throw new Error("Expected completed fixture");
  source.state.metadata = { ...source.state.metadata, legalworkToolResults: [{ tool, input: {}, output }] };
  for (const parts of [parseDynamicToolUIParts(projectTool(session.id, "assistant", source)), history(source)]) {
    expect(getAssistantRenderGroups(parts, false).map(group => group.kind)).toEqual([kind]);
  }
});

test("connector drafts retain their attested action input", () => {
  const source = native("legalwork_extension_call", { ok: true, referenceData: { result: cases[3].output } }, { extensionId: "gmail", action: "create_draft" });
  const parts = parseDynamicToolUIParts(projectTool(session.id, "assistant", source));
  expect(getAssistantRenderGroups(parts, false)[0].kind).toBe("email-draft");
  expect(parts[0].input).toEqual({ extensionId: "gmail", action: "create_draft" });
});

test("filed-task links survive Code Mode and saved history", () => {
  const parts = history(native("legalwork_task_create", { ok: true, task: { id, title: "Follow up", origin: "desktop" } }));
  expect(filedTasksOf(parts)).toEqual([{ id, title: "Follow up" }]);
});

test("shared Assistant files survive hidden activity, keep project scope and deduplicate", () => {
  const output = { ok: true, file: { path: "Reports/briefing.view.json", title: "Morning briefing", documentType: "report", size: 100,
    source: { workspaceId: "matter", workspaceRoot: "/fixture/matter", projectName: "Matter" } } };
  const source = native("legalwork_assistant_share_file", [output, output]);
  if (source.state.status !== "completed") throw new Error("Expected completed fixture");
  source.state.metadata = { toolCalls: [{ tool: "read", status: "completed" }, ...[1, 2].map(() => ({ tool: "legalwork_assistant_share_file", status: "completed" }))] };
  const messages = assistantChatMessages([{ id: "assistant", role: "assistant", parts: history(source) }]);
  expect(messages[0].parts).toHaveLength(1);
  const card = messages[0].parts[0];
  if (card.type !== "dynamic-tool") throw new Error("Expected file card");
  expect(sharedAssistantFile(card)).toEqual(output.file);
});

test("unconfirmed delegations keep their warning card without treating failed calls as success", () => {
  const delegation = { workspaceId: "matter", sessionId: "child", projectName: "Matter", title: "Review", scope: "Provider side", status: "delivery-unconfirmed" };
  const output = { ok: false, delegation, error: "Delivery could not be confirmed." };
  const parts = history(native("legalwork_assistant_delegate", output));
  expect(getAssistantRenderGroups(parts, false).map(group => group.kind)).toEqual(["delegation"]);
  expect(parseDelegationCard(output)?.status).toBe("delivery-unconfirmed");
  for (const rejected of [
    { ok: false, error: "No chat created" },
    { ok: false, delegation: { ...delegation, status: "started" } },
    { ok: false, referenceData: { ok: true, delegation: { ...delegation, status: "started" } } },
  ]) expect(getAssistantRenderGroups(history(native("legalwork_assistant_delegate", rejected)), false)[0].kind).toBe("tools");
});

test("file and name cards require a successful recorded call and validated result", () => {
  for (const { tool, output } of cases.filter(item => item.kind === "assistant-file" || item.kind === "assistant-name")) {
    for (const status of ["running", "error"]) {
      const source = native(tool, output);
      if (source.state.status !== "completed") throw new Error("Expected completed fixture");
      source.state.metadata = { toolCalls: [{ tool, status }] };
      expect(getAssistantRenderGroups(history(source), false)[0].kind).toBe("tools");
    }
    for (const invalid of [{ ...output, ok: false }, { ok: true }, null]) {
      expect(getAssistantRenderGroups(history(native(tool, invalid)), false)[0].kind).toBe("tools");
    }
  }
});

test("results returned in a different order retain the right draft kind", () => {
  const source = native("legalwork_email_draft", [cases[4].output, cases[3].output]);
  if (source.state.status !== "completed") throw new Error("Expected completed fixture");
  source.state.metadata = { toolCalls: [{ tool: "legalwork_email_draft", status: "completed" }, { tool: "legalwork_calendar_event_draft", status: "completed" }] };
  expect(getAssistantRenderGroups(history(source), false).map(group => group.kind)).toEqual(["calendar-event-draft", "email-draft"]);
});

test("LegalMemory source lists recognize native namespaced retrievals in Code Mode", () => {
  const source = native("legalmemory.search_semantic", [{ document_id: id, title: "Agreement", version_status: "executed" }]);
  const documents = collectLegalMemoryDocuments(legalMemoryOutputsOf(history(source)));
  expect(documents.map(item => item.documentId)).toEqual([id]);
  if (source.state.status !== "completed") throw new Error("Expected completed fixture");
  source.state.metadata = { toolCalls: [{ tool: "legalmemory.search_semantic", status: "error" }] };
  expect(legalMemoryOutputsOf(history(source))).toEqual([]);
  source.state.metadata = { toolCalls: [{ tool: "other.search_semantic", status: "completed" }] };
  expect(legalMemoryOutputsOf(history(source))).toEqual([]);
});

test("a returned batch displays each widget once with stable identities", () => {
  const output = cases[2].output;
  const source = native("legalwork_calculation_present", [output, output]);
  if (source.state.status !== "completed") throw new Error("Expected completed fixture");
  source.state.metadata = { toolCalls: [1, 2].map(() => ({ tool: "legalwork_calculation_present", status: "completed" })) };
  const parts = history(source);
  expect(parts.filter(part => part.type === "dynamic-tool").map(part => part.toolCallId)).toEqual(["execute-call", "execute-call:widget:1"]);
  expect(getAssistantRenderGroups(parts, false).map(group => group.kind)).toEqual(["calculation", "calculation"]);
});

test("mixed batches retain activity for calls without cards", () => {
  const source = native("legalwork_email_draft", cases[3].output);
  if (source.state.status !== "completed") throw new Error("Expected completed fixture");
  source.state.metadata = { toolCalls: [{ tool: "storage_read_file", status: "completed" }, { tool: "legalwork_email_draft", status: "completed" }] };
  const parts = history(source);
  expect(getAssistantRenderGroups(parts, false).map(group => group.kind)).toEqual(["tools", "email-draft"]);
  expect(parts.filter(part => part.type === "dynamic-tool").map(part => part.toolCallId)).toEqual(["execute-call", "execute-call:widget:0"]);
});

test("recorded tool names replace Execute in live activity, history and grouped summaries", () => {
  const source = native("storage_list_folder", {});
  if (source.state.status !== "completed") throw new Error("Expected completed fixture");
  source.state.metadata = { toolCalls: [{ tool: "storage_list_folder", status: "completed" }, { tool: "storage_read_file", status: "running" }, { tool: "storage_read_file", status: "error" }] };
  const part = parseDynamicToolUIParts(projectTool(session.id, "assistant", source))[0];
  expect(getToolHistoryLabel(part)).toBe("Storage list folder · Storage read file");
  expect(getToolRunSummary([part, { ...part, toolCallId: "second" }])).toBe("Storage list folder · Storage read file");
  const running = { ...part, state: "input-streaming", output: undefined } satisfies import("ai").DynamicToolUIPart;
  expect(getToolActivityLabel(running)).toBe("Running Storage list folder · Storage read file");
  expect(getToolHistoryLabel({ ...part, state: "output-error", output: undefined, errorText: "Failed" })).toContain("Storage read file");
  const unrecorded = native("other", {});
  if (unrecorded.state.status !== "completed") throw new Error("Expected completed fixture");
  unrecorded.state.metadata = {};
  unrecorded.state.input = { code: "return tools.secret_tool()" };
  expect(getToolHistoryLabel(parseDynamicToolUIParts(projectTool(session.id, "assistant", unrecorded))[0])).toBe("Execute");
});

test("Code Mode activity restores each inner tool's icon while running and after completion", () => {
  for (const [tool, icon] of [["storage_read_file", BookOpen], ["inapp_documents_open", BookOpen], ["inapp_md_replace_text", FilePenLine], ["inapp_markdown_create", FilePlus2], ["storage_list_folder", FolderSearch], ["legalmemory.search_semantic", Search], ["legalwork_shell", SquareTerminal]] satisfies Array<[string, typeof BookOpen]>) {
    const source = native(tool, {});
    const mapped = projectTool(session.id, "assistant", source);
    for (const part of [mapped, { ...mapped, state: { status: "running", input: mapped.state.input, metadata: { toolCalls: [{ tool, status: "running" }] }, time: { start: 1 } } } satisfies typeof mapped]) {
      expect(getToolIcon(parseDynamicToolUIParts(part)[0])).toBe(icon);
    }
  }
});

test("unrelated, failed and unreturned results never become widgets", () => {
  for (const calls of [[], [{ tool: "other", status: "completed" }], [{ tool: "constructor", status: "completed" }], [{ tool: "legalwork_email_draft", status: "error" }]]) {
    const source = native("legalwork_email_draft", cases[3].output);
    if (source.state.status !== "completed") throw new Error("Expected completed fixture");
    source.state.metadata = { toolCalls: calls };
    expect(getAssistantRenderGroups(history(source), false)[0].kind).toBe("tools");
  }
  for (const output of [{ ok: false, ...cases[3].output }, { draft: { id } }, null]) {
    expect(getAssistantRenderGroups(history(native("legalwork_email_draft", output)), false)[0].kind).toBe("tools");
  }
});

afterEach(() => getReactQueryClient().clear());
test("live completion replaces the execute placeholder with the returned widget batch", () => {
  const input = { workspaceId: "widgets", baseUrl: "http://127.0.0.1:1", legalworkToken: "fixture" };
  const dispose = __createWorkspaceSessionSyncForTest(input), release = trackWorkspaceSessionSync(input, session.id);
  try {
    const data = { sessionID: session.id, assistantMessageID: "assistant", id: "execute-call" };
    const common = { id: "event", created: 1, location: { directory: "/fixture" }, durable: { aggregateID: session.id, seq: 1, version: 1 } };
    __applySessionSyncEventForTest(input, { ...common, type: "session.step.started", data: { sessionID: session.id, assistantMessageID: "assistant", agent: "legalwork", model: { providerID: "fixture", id: "model" }, started: 1 } });
    __applySessionSyncEventForTest(input, { ...common, type: "session.tool.input.started", data: { ...data, name: "execute" } });
    __applySessionSyncEventForTest(input, { ...common, type: "session.tool.called", data: { ...data, input: { code: "return result;" }, executed: true } });
    __applySessionSyncEventForTest(input, { ...common, durable: { ...common.durable, version: 2 }, type: "session.tool.success", data: { ...data, content: [{ type: "text", text: JSON.stringify([cases[3].output, cases[4].output]) }], metadata: { toolCalls: [{ tool: "legalwork_email_draft", status: "completed" }, { tool: "legalwork_calendar_event_draft", status: "completed" }] }, executed: true } });
    const parts = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, session.id))?.[0]?.parts ?? [];
    expect(getAssistantRenderGroups(parts, false).map(group => group.kind)).toEqual(["email-draft", "calendar-event-draft"]);
  } finally { release(); dispose(); }
});
