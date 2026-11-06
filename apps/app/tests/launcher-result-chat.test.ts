import { expect, test } from "bun:test";
import type { AssistantConversation, AssistantExecutionTarget } from "@legalwork/types/launcher";
import { resultChatProject, startLauncherResultChat } from "../src/react-app/launcher/launcher-result-chat";

const projects = [{ id: "a" }, { id: "b" }, { id: "wiki", preset: "wiki" }, { id: "assistant", preset: "main-assistant" }];
const conversation = (workspaceId: string, id: string): AssistantConversation => ({ id, workspaceId, sessionId: `session_${id}`, title: "Contract", kind: "conversation", date: null, createdAt: 0, updatedAt: 0, pinned: false, archivedAt: null, origin: "panel" });

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
