import { getToolName, isToolUIPart, type UIMessage, type ToolUIPart, type DynamicToolUIPart } from "ai";
import { AssistantReactionResultSchema, AssistantSharedFileResultSchema, type AssistantFileSource } from "@legalwork/types/main-assistant";
import { widgetOutput } from "@/react-app/domains/session/sync/parse-tool-parts";
import { Marked } from "marked";
import { classifyOpenTarget, resolvePathOpenTarget, type OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import type { ArtifactPanelTab } from "@/react-app/domains/session/panel/panel-tab-store";

const fileLinks = new Marked();

/** Older replies deliberately linked deliverables before the share-file tool existed. */
export function linkedAssistantFiles(messages: UIMessage[], openTargets: OpenTarget[]) {
  const files = new Map<string, { path: string; title: string }>();
  const shared = new Set(messages.flatMap(message => message.parts.flatMap(part => {
    if (!isToolUIPart(part) || !isAssistantFileTool(part)) return [];
    const file = sharedAssistantFile(part);
    const target = file && !file.source && resolvePathOpenTarget(file.path, openTargets);
    return target ? [target.id] : [];
  })));
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      fileLinks.walkTokens(fileLinks.lexer(part.text), token => {
        if (token.type !== "link" || /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(token.href)) return;
        let path: string;
        try { path = decodeURIComponent(token.href).split("#")[0]; } catch { return; }
        const target = resolvePathOpenTarget(path, openTargets);
        if (!target || target.exists === false || shared.has(target.id)) return;
        files.set(target.id, { path: target.value, title: token.text === token.href || token.text === path ? target.name : token.text });
      });
    }
  }
  return [...files.values()];
}

export const isAssistantFileTool = (part: ToolUIPart | DynamicToolUIPart) => getToolName(part) === "legalwork_assistant_share_file";
function outputOf(part: ToolUIPart | DynamicToolUIPart): unknown {
  if (part.state !== "output-available") return null;
  try { return typeof part.output === "string" ? JSON.parse(widgetOutput(part.output)) : part.output; }
  catch { return null; }
}
export function sharedAssistantFile(part: ToolUIPart | DynamicToolUIPart) {
  const result = AssistantSharedFileResultSchema.safeParse(outputOf(part));
  return result.success ? result.data.file : null;
}

export function assistantProjectFileTab(file: { path: string; title: string; size?: number; source?: AssistantFileSource }): ArtifactPanelTab | null {
  if (!file.source) return null;
  return { id: `project-file:${encodeURIComponent(file.source.workspaceId)}:${encodeURIComponent(file.path)}`, type: "artifact", label: file.title,
    value: file.path, preview: classifyOpenTarget(file.path, "file"), size: file.size, source: file.source };
}

/** Chat contains prose and deliberately offered cards, never an automatic activity feed. */
export function assistantChatMessages(messages: UIMessage[]): UIMessage[] {
  const sharedPaths = new Set<string>();
  return messages.flatMap(message => {
    if (message.role !== "assistant") { if (message.role === "user") sharedPaths.clear(); return [message]; }
    const parts = message.parts.filter(part => {
      if (part.type === "text") return true;
      if (!isToolUIPart(part) || part.state !== "output-available") return false;
      if (isAssistantFileTool(part)) {
        const file = sharedAssistantFile(part);
        if (!file) return false;
        const key = JSON.stringify([file.source?.workspaceId ?? null, file.path]);
        if (sharedPaths.has(key)) return false;
        sharedPaths.add(key);
        return true;
      }
      return ["legalwork_assistant_delegate", "legalwork_assistant_set_name", "legalwork_schedule_create", "legalwork_schedule_update", "legalwork_calculation_present"].includes(getToolName(part));
    });
    return parts.length ? [{ ...message, parts }] : [];
  });
}

export function assistantReactions(messages: UIMessage[]) {
  const users = new Set(messages.filter(message => message.role === "user").map(message => message.id));
  const reactions = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolUIPart(part) || getToolName(part) !== "legalwork_assistant_react") continue;
      const result = AssistantReactionResultSchema.safeParse(outputOf(part));
      if (result.success && users.has(result.data.reaction.messageId)) reactions.set(result.data.reaction.messageId, result.data.reaction.emoji);
    }
  }
  return reactions;
}
