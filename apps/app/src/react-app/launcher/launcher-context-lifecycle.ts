import type { AssistantContextItem, LauncherWorkspaceContext } from "@legalwork/types/launcher";

/** Search-result references were deliberately attached; screen selections are transient. */
export function isCapturedSelection(item: AssistantContextItem) {
  return item.type === "selection" && !/^(rec|task|chat)_/.test(item.id);
}

/** Captured selections belong to one invocation, never to a saved chat draft. */
export function persistentContext(items: AssistantContextItem[]) {
  return items.filter(item => !isCapturedSelection(item));
}

/** Explicit handoff preserves the selected passage as a deliberate draft attachment. */
export function handoffContext(items: AssistantContextItem[]): AssistantContextItem[] {
  return items.map(item => isCapturedSelection(item) && item.type === "selection" ? {
    id: item.id, type: "clipboard", capturedAt: item.capturedAt,
    text: [[item.sourceApp, item.sourceWindow].filter(Boolean).join(" · "), item.text].filter(Boolean).join("\n\n"),
  } : item);
}

/** A new chat takes the current view and selection, not attachments from a previous draft. */
export function newChatContext(invocation: LauncherWorkspaceContext | null, projectId: string | undefined,
  items: AssistantContextItem[], previous: LauncherWorkspaceContext | null): AssistantContextItem[] {
  if (!invocation) return previous ? [] : items.filter(isCapturedSelection);
  if (invocation.workspaceId !== projectId) return [];
  const current = previous?.workspaceId === projectId && previous?.capturedAt === invocation.capturedAt ? items : [];
  const context: AssistantContextItem[] = [];
  const { document, selection } = invocation;
  if (document) {
    const existing = current.find(item => item.type === "file" && item.id.startsWith("view_") && item.path === document.path && item.workspaceId === document.workspaceId);
    context.push(existing ?? { ...document, id: `view_${crypto.randomUUID()}`, type: "file", revision: document.revision ?? null,
      sourceLabel: (document.workspaceId === projectId ? invocation.workspaceName : document.workspaceId).slice(0, 200) });
  }
  if (selection) {
    const existing = current.find(item => item.type === "selection" && isCapturedSelection(item) && item.text === selection);
    context.push(existing ?? { id: `selection_${crypto.randomUUID()}`, type: "selection", text: selection,
      sourceApp: "LegalWork", sourceWindow: document?.name ?? invocation.workspaceName, capturedAt: invocation.capturedAt });
  }
  return context;
}
