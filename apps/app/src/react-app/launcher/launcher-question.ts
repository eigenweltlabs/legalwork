import type { ModelRef } from "@/app/types";
import type { AssistantContextItem, AssistantExecutionTarget, LauncherDraft, LauncherInvocation, LauncherWorkspaceContext } from "@legalwork/types/launcher";

export type LauncherQuestion = {
  text: string;
  items: AssistantContextItem[];
  workspace: LauncherWorkspaceContext | null;
  operationId: string;
};

export async function questionDestination(projectId: string | undefined, assistantIncluded: () => Promise<boolean>) {
  if (projectId) return { kind: "project", workspaceId: projectId } as const;
  return await assistantIncluded() ? { kind: "assistant" } as const : { kind: "choose-project" } as const;
}

export function opensQuestionComposer(invocation: Pick<LauncherInvocation, "action" | "conversationId">, hasSelection: boolean) {
  return !invocation.conversationId && (invocation.action === "ask" || invocation.action === "new-conversation" || invocation.action === "open" && hasSelection);
}

/** A project model is local to its chat, including follow-ups and opening it in the app. */
export function launcherChatModel(target: AssistantExecutionTarget, draft: Pick<LauncherDraft, "model" | "variant">,
  defaults: { defaultModel: ModelRef | null; modelVariant: string | null }, fresh?: ModelRef) {
  if (target.kind === "project" && !fresh && draft.model) return { model: draft.model, variant: draft.variant };
  const model = fresh ?? defaults.defaultModel;
  const same = !fresh || fresh.providerID === defaults.defaultModel?.providerID && fresh.modelID === defaults.defaultModel?.modelID;
  return { model, variant: same ? defaults.modelVariant : null };
}
