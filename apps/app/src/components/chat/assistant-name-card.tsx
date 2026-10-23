import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { AssistantNameResultSchema } from "@legalwork/types/main-assistant";
import { AssistantAvatarQuestion } from "@/react-app/domains/session/surface/assistant-onboarding-conversation";
import { useMessageList } from "./message-list-provider";
import { Tool } from "@/components/ui/tool";

export const isAssistantNameTool = (part: ToolUIPart | DynamicToolUIPart) => getToolName(part) === "legalwork_assistant_set_name";
export function parseAssistantNameResult(output: unknown) {
  try { const result = AssistantNameResultSchema.safeParse(typeof output === "string" ? JSON.parse(output) : output); return result.success ? result.data : null; }
  catch { return null; }
}

export function AssistantNameCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const { legalworkClient: client, workspaceId, readOnly } = useMessageList();
  const cache = useQueryClient();
  const result = part.state === "output-available" ? parseAssistantNameResult(part.output) : null;
  const state = useQuery({
    queryKey: ["assistant-onboarding", client?.baseUrl], enabled: Boolean(client && result?.showAvatarPicker),
    queryFn: () => { if (!client) throw new Error("Assistant unavailable"); return client.mainAssistantOnboarding(); },
  });
  useEffect(() => {
    if (!result || !client) return;
    void cache.invalidateQueries({ queryKey: ["assistant-onboarding", client.baseUrl] });
    void cache.invalidateQueries({ queryKey: ["main-assistant", client.baseUrl] });
  }, [cache, client, part.state, part.toolCallId]);
  if (!result?.showAvatarPicker) return <Tool toolPart={part} />;
  const current = state.data?.agentNamed ? state.data : result.onboarding;
  return <AssistantAvatarQuestion workspaceId={workspaceId} state={current} onIcon={!client || readOnly ? undefined : async icon => {
    const next = await client.answerAssistantOnboarding({ icon });
    cache.setQueryData(["assistant-onboarding", client.baseUrl], next);
    await cache.invalidateQueries({ queryKey: ["main-assistant", client.baseUrl] });
  }} />;
}
