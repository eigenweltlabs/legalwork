import type { AssistantConversation, AssistantExecutionTarget, LauncherSearchResult } from "@legalwork/types/launcher";

export type ResultChatAction = "chat-with-assistant" | "ask" | "summarize" | "compare";

/** A registered project chat stays project-bound even before Assistant bootstrap completes. */
export function conversationTarget(conversation: { workspaceId: string; origin?: string | null }, assistantWorkspaceId: string | undefined, fallback: AssistantExecutionTarget): AssistantExecutionTarget {
  return conversation.origin?.startsWith("project:") || assistantWorkspaceId && conversation.workspaceId !== assistantWorkspaceId
    ? { kind: "project", workspaceId: conversation.workspaceId } : fallback;
}

/** Use the item's own project; external/wiki context needs a current project or an explicit choice. */
export function resultChatProject(items: Pick<LauncherSearchResult, "workspaceId">[], projects: { id: string; preset?: string }[], currentProjectId?: string) {
  const ids = new Set(projects.filter(project => project.preset !== "wiki" && project.preset !== "main-assistant").map(project => project.id));
  const sources = [...new Set(items.flatMap(item => item.workspaceId && ids.has(item.workspaceId) ? [item.workspaceId] : []))];
  return sources.length === 1 ? sources[0] : sources.length > 1 ? undefined : currentProjectId && ids.has(currentProjectId) ? currentProjectId : undefined;
}

/** Each project action gets a fresh chat; only an explicit summary sends after context was safely staged. */
export async function startLauncherResultChat(input: { action: ResultChatAction; workspaceId?: string; title: string }, operations: {
  assistant: () => Promise<AssistantConversation>;
  project: (workspaceId: string, operationId: string, title: string) => Promise<AssistantConversation>;
  stage: (conversation: AssistantConversation, target: AssistantExecutionTarget) => Promise<void>;
  send: (conversation: AssistantConversation) => Promise<void>;
}) {
  let target: AssistantExecutionTarget;
  if (input.action === "chat-with-assistant") target = { kind: "assistant" };
  else {
    if (!input.workspaceId) throw new Error("Choose a project for this chat.");
    target = { kind: "project", workspaceId: input.workspaceId };
  }
  const conversation = target.kind === "assistant" ? await operations.assistant() : await operations.project(target.workspaceId, crypto.randomUUID(), input.title);
  await operations.stage(conversation, target);
  if (input.action === "summarize") await operations.send(conversation);
  return conversation;
}
