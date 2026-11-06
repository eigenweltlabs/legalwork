import type { QueryClient } from "@tanstack/react-query";
import type { AssistantConversation } from "@legalwork/types/launcher";
import type { AssistantProfile } from "@legalwork/types/main-assistant";
import type { LegalworkServerClient, LegalworkWorkspaceInfo } from "@/app/lib/legalwork-server";

export type AssistantShellState = { workspace: LegalworkWorkspaceInfo; profile: AssistantProfile; conversation: AssistantConversation | null; day: { date: string; sessionId: string } | null };
export const assistantShellQueryKey = (baseUrl: string) => ["main-assistant", baseUrl];

/** Local calendar date, the way daily history is keyed. */
export function localAssistantDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Home and the panel bind to a concrete conversation. Reading never creates
 * one; a navigation into the Assistant, or a first message, does so explicitly.
 */
export async function resolveAssistantConversation(
  client: Pick<LegalworkServerClient, "baseUrl" | "assistantConversationCurrent" | "createAssistantConversation">,
  cache: QueryClient,
  origin: "home" | "navigation" = "home",
) {
  const current = await client.assistantConversationCurrent();
  const workspace = current.workspace;
  if (!workspace) throw new Error("The Assistant is not set up yet.");
  const conversation = current.conversation ?? (await client.createAssistantConversation({ origin })).conversation;
  cache.setQueryData<AssistantShellState>(assistantShellQueryKey(client.baseUrl), previous => previous ? { ...previous, conversation } : { workspace, profile: current.profile, conversation, day: current.day });
  return { workspace, profile: current.profile, conversation, sessionId: conversation.sessionId };
}
