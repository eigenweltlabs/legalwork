import type { QueryClient } from "@tanstack/react-query";
import type { AssistantConversation } from "@legalwork/types/launcher";
import type { AssistantProfile } from "@legalwork/types/main-assistant";
import type { LegalworkServerClient, LegalworkWorkspaceInfo } from "@/app/lib/legalwork-server";

export type AssistantShellState = { workspace: LegalworkWorkspaceInfo; profile: AssistantProfile; conversation: AssistantConversation | null; day: { date: string; sessionId: string } | null };
export const assistantShellQueryKey = (baseUrl: string) => ["launcher-assistant-shell", baseUrl];

/** Identify the Assistant chat for the workspace pane, including explicit conversations. */
export function assistantChatIdentity(
  state: AssistantShellState | null | undefined,
  sessionId: string | null,
  resolved: AssistantConversation | null | undefined,
) {
  const conversation = [resolved, state?.conversation].find(item =>
    item?.sessionId === sessionId && item.workspaceId === state?.workspace.id,
  );
  if (conversation) return { sessionId: conversation.sessionId, date: conversation.kind === "day" ? conversation.date : null };
  return state?.day ?? undefined;
}

/**
 * Home and the panel bind to a concrete conversation. Reading never creates
 * one; a navigation into the Assistant, or a first message, does so explicitly.
 */
export async function resolveAssistantConversation(
  client: Pick<LegalworkServerClient, "baseUrl" | "assistantConversationCurrent" | "createAssistantConversation" | "ensureAssistantWorkspace">,
  cache: QueryClient,
  origin: "home" | "navigation" = "home",
  projectFields?: Parameters<LegalworkServerClient["ensureAssistantWorkspace"]>[0],
) {
  const current = await client.assistantConversationCurrent();
  const workspace = current.workspace ?? (await client.ensureAssistantWorkspace(projectFields)).workspace;
  const conversation = current.conversation ?? (await client.createAssistantConversation({ origin })).conversation;
  cache.setQueryData<AssistantShellState>(assistantShellQueryKey(client.baseUrl), previous => previous ? { ...previous, conversation } : { workspace, profile: current.profile, conversation, day: current.day });
  return { workspace, profile: current.profile, conversation, sessionId: conversation.sessionId };
}
