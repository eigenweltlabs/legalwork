import type { LauncherDraft } from "@legalwork/types/launcher";
import { taskReference } from "@/react-app/domains/tasks/task-reference";
import { createProjectAttachmentMention, createWorkspaceAttachmentMention } from "@/react-app/domains/session/surface/composer/workspace-attachment";

/** The panel's complete draft as Home composer text: file references become attachment mentions, captured text is quoted. */
export function launcherDraftToComposerText(draft: Pick<LauncherDraft, "text" | "context">, assistantWorkspaceId: string, projectNames: Map<string, string>) {
  const parts = [draft.text.trim()];
  for (const item of draft.context) {
    if (item.type === "task") parts.push(taskReference(item.taskId));
    else if (item.type === "file" && item.path) parts.push(item.workspaceId && item.workspaceId !== assistantWorkspaceId ? createProjectAttachmentMention({ projectId: item.workspaceId, workspaceId: item.workspaceId, path: item.path, name: item.name }, projectNames.get(item.workspaceId) ?? item.sourceLabel ?? item.workspaceId) : createWorkspaceAttachmentMention(item.name, item.path));
    else if (item.type === "image" && item.path) parts.push(item.workspaceId && item.workspaceId !== assistantWorkspaceId ? createProjectAttachmentMention({ projectId: item.workspaceId, workspaceId: item.workspaceId, path: item.path, name: item.name }, projectNames.get(item.workspaceId) ?? item.workspaceId) : createWorkspaceAttachmentMention(item.name, item.path));
    else if (item.type === "selection") parts.push(`${item.sourceApp ? `${item.sourceApp}${item.sourceWindow ? ` (${item.sourceWindow})` : ""}:\n` : ""}"""\n${item.text}\n"""`);
    else if (item.type === "clipboard") parts.push(`"""\n${item.text}\n"""`);
  }
  return parts.filter(Boolean).join("\n\n");
}
