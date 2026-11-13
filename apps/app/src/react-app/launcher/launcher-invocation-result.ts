import { launcherResultActions, LauncherInvocationResultActionSchema, LauncherResultReferenceSchema, type LauncherInvocation, type LauncherResultReference, type LauncherSearchResult } from "@legalwork/types/launcher";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function launcherInvocationResultAction(result: LauncherSearchResult, requested: LauncherInvocation["resultAction"]) {
  const action = LauncherInvocationResultActionSchema.parse(requested ?? "open");
  if (!launcherResultActions(result).includes(action)) throw new Error(t("launcher.notice.action_unknown"));
  return action;
}

/** External launchers carry identity, never an executable route or trusted cached metadata. */
export async function resolveLauncherInvocationResult(reference: LauncherResultReference, client: Pick<LegalworkServerClient, "visibleLauncherFiles" | "launcherPreview" | "assistantConversation" | "listWorkspaces">): Promise<LauncherSearchResult> {
  const input = LauncherResultReferenceSchema.parse(reference);
  const result: LauncherSearchResult = { ...input, title: input.id, updatedAt: 0, score: 0, match: "exact", actions: ["open"] };
  if (input.kind === "files") {
    const path = input.path ?? input.id;
    result.path = path;
    result.title = path.split(/[\\/]/).at(-1) || input.id;
    const { items } = await client.visibleLauncherFiles([result]);
    const found = items.find(item => item.id === result.id && item.sourceId === result.sourceId);
    if (!found) throw new Error(t("launcher.chat.context_unavailable"));
    return found;
  }
  if (input.kind === "chats" && input.sourceId === "assistant") {
    const { conversation } = await client.assistantConversation(input.id);
    if (conversation.archivedAt) throw new Error(t("launcher.conversation.unavailable"));
    return { ...result, workspaceId: conversation.workspaceId, sessionId: conversation.sessionId, title: conversation.title, updatedAt: conversation.updatedAt };
  }
  if (input.kind === "projects") {
    const response = await client.listWorkspaces();
    const workspace = (response.items ?? response.workspaces ?? []).find(item => item.id === input.workspaceId && item.id === input.id);
    if (!workspace) throw new Error(t("launcher.chat.context_unavailable"));
    return { ...result, title: workspace.displayName || workspace.name };
  }
  const preview = await client.launcherPreview({ kind: input.kind, id: input.kind === "chats" ? input.sessionId ?? input.id : input.id, workspaceId: input.workspaceId });
  return { ...result, title: preview.title, updatedAt: preview.updatedAt ?? 0 };
}
