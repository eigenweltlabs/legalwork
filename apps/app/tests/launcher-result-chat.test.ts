import { creationContext, handoffContext } from "../src/react-app/launcher/launcher-context-lifecycle";
import { expect, test } from "bun:test";
import type { AssistantConversation, AssistantExecutionTarget } from "@legalwork/types/launcher";
import { conversationTarget, resultChatProject, startLauncherResultChat } from "../src/react-app/launcher/launcher-result-chat";

const projects = [{ id: "a" }, { id: "b" }, { id: "wiki", preset: "wiki" }, { id: "assistant", preset: "main-assistant" }];
const conversation = (workspaceId: string, id: string): AssistantConversation => ({ id, workspaceId, sessionId: `session_${id}`, title: "Contract", kind: "conversation", date: null, createdAt: 0, updatedAt: 0, pinned: false, archivedAt: null, origin: "panel" });

test("resuming a BYOK project chat remains project-bound without a general Assistant", () => {
  expect(conversationTarget({ workspaceId: "a", origin: "project:bind_session" }, undefined, { kind: "assistant" })).toEqual({ kind: "project", workspaceId: "a" });
  expect(conversationTarget({ workspaceId: "assistant", origin: "panel" }, undefined, { kind: "assistant" })).toEqual({ kind: "assistant" });
  expect(conversationTarget({ workspaceId: "a" }, "assistant", { kind: "assistant" })).toEqual({ kind: "project", workspaceId: "a" });
});

test("project chat uses the source project, falling back only to a valid current project", () => {
  expect(resultChatProject([{ workspaceId: "a" }], projects, "b")).toBe("a");
  expect(resultChatProject([{ workspaceId: "wiki" }], projects, "b")).toBe("b");
  expect(resultChatProject([{ workspaceId: null }], projects, "a")).toBe("a");
  expect(resultChatProject([{ workspaceId: "a" }, { workspaceId: "b" }], projects, "a")).toBeUndefined();
  expect(resultChatProject([{ workspaceId: "wiki" }], projects, "assistant")).toBeUndefined();
  expect(resultChatProject([{ workspaceId: "deleted" }], projects)).toBeUndefined();
});

function setup() {
  const steps: string[] = [];
  const ids: string[] = [];
  const staged: { conversation: AssistantConversation; target: AssistantExecutionTarget }[] = [];
  const currentAssistant = conversation("assistant", "current");
  return { steps, ids, staged, currentAssistant, operations: {
    assistant: async () => { steps.push("assistant"); return currentAssistant; },
    project: async (workspaceId: string, operationId: string) => { steps.push(`project:${workspaceId}`); ids.push(operationId); return conversation(workspaceId, operationId); },
    stage: async (chat: AssistantConversation, target: AssistantExecutionTarget) => { steps.push(`stage:${chat.workspaceId}`); staged.push({ conversation: chat, target }); },
    send: async (chat: AssistantConversation) => { steps.push(`send:${chat.workspaceId}`); },
  } };
}

test("Ask about this creates a fresh project chat every time and never auto-sends", async () => {
  const fixture = setup();
  for (let i = 0; i < 2; i++) await startLauncherResultChat({ action: "ask", workspaceId: "a", title: "Contract" }, fixture.operations);
  expect(fixture.steps).toEqual(["project:a", "stage:a", "project:a", "stage:a"]);
  expect(new Set(fixture.ids).size).toBe(2);
  expect(fixture.staged.every(item => item.target.kind === "project" && item.target.workspaceId === "a")).toBe(true);
});

test("Chat with Assistant explicitly resumes the general Assistant, never the source project's chat", async () => {
  const fixture = setup();
  const found = await startLauncherResultChat({ action: "chat-with-assistant", workspaceId: "a", title: "Contract" }, fixture.operations);
  expect(found).toBe(fixture.currentAssistant);
  expect(fixture.steps).toEqual(["assistant", "stage:assistant"]);
  expect(fixture.staged[0].target).toEqual({ kind: "assistant" });
});

test("Summarize sends once, only after project context has finished staging", async () => {
  const fixture = setup();
  await startLauncherResultChat({ action: "summarize", workspaceId: "b", title: "Contract" }, fixture.operations);
  expect(fixture.steps).toEqual(["project:b", "stage:b", "send:b"]);
  expect(fixture.staged[0].target).toEqual({ kind: "project", workspaceId: "b" });
});

test("missing project and failed attachment never fall through to the Assistant or send a partial summary", async () => {
  const fixture = setup();
  await expect(startLauncherResultChat({ action: "summarize", title: "Contract" }, fixture.operations)).rejects.toThrow("Choose a project");
  expect(fixture.steps).toEqual([]);
  await expect(startLauncherResultChat({ action: "summarize", workspaceId: "a", title: "Contract" }, {
    ...fixture.operations, stage: async () => { throw new Error("File unavailable"); },
  })).rejects.toThrow("File unavailable");
  expect(fixture.steps).toEqual(["project:a"]);
});

test("new chat keeps only the invoked view and selection, even if the bar retains another project's draft", () => {
  const active = { workspaceId: "alpha", workspaceName: "Alpha", capturedAt: 10, document: { workspaceId: "alpha", path: "contract.docx", name: "Contract" }, selection: "Selected clause" };
  const earlier = { workspaceId: "beta", workspaceName: "Beta", capturedAt: 1 };
  const saved = [{ type: "clipboard" as const, id: "old", text: "Old draft", capturedAt: 1 }];
  const fresh = creationContext(active, "alpha", saved, earlier);
  expect(fresh.map(item => item.type)).toEqual(["file", "selection"]);
  expect(handoffContext(fresh)[1]).toMatchObject({ type: "clipboard", text: expect.stringContaining("Selected clause") });
  expect(creationContext(active, "alpha", [...fresh, ...saved], active)).toEqual(fresh);
  expect(creationContext(active, "alpha", saved, active).map(item => item.type)).toEqual(["file", "selection"]);
  expect(creationContext({ ...active, selection: undefined }, "alpha", fresh, active)).toEqual([fresh[0]]);
  expect(creationContext(active, "beta", fresh, active)).toEqual([]);
  expect(creationContext(null, "beta", fresh, active)).toEqual([]);
  const selected = { type: "selection" as const, id: "selection_x", text: "Safari", capturedAt: 10, sourceApp: "Safari", sourceWindow: null };
  expect(creationContext(null, undefined, [...saved, selected], null)).toEqual([selected]);
});

test("creating in B from its task list cannot use the parked clipboard or file from A", () => {
  const previous = { workspaceId: "A", workspaceName: "First", capturedAt: 1 };
  const current = { workspaceId: "B", workspaceName: "Second", capturedAt: 2 };
  expect(creationContext(current, "B", [
    { id: "draft_clip", type: "clipboard", text: "A's draft", capturedAt: 1 },
    { id: "old", type: "file", workspaceId: "A", path: "private.txt", name: "private", revision: null, sourceLabel: "First" },
  ], previous)).toEqual([]);
});
