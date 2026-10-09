import type { UIMessage } from "ai";
import type { AssistantChannelHistory } from "@legalwork/types/main-assistant";

export function isChannelHistoryMessage(message: UIMessage) {
  return typeof message.metadata === "object" && message.metadata !== null && Reflect.get(message.metadata, "legalworkChannelHistory") === true;
}
function created(message: UIMessage) {
  const info = typeof message.metadata === "object" && message.metadata !== null ? Reflect.get(message.metadata, "opencode") : undefined;
  const time = typeof info === "object" && info !== null ? Reflect.get(info, "created") : undefined;
  return typeof time === "number" ? time : null;
}

/** Display projection only: never seed the OpenCode transcript or prompt queue. */
export function mergeAssistantChannelHistory(native: UIMessage[], history?: AssistantChannelHistory): UIMessage[] {
  if (!history) return native;
  const nativeIds = new Set(native.map(message => message.id));
  const targetIds = new Map(history.messages.map(message => [message.id,
    message.localMessageId && nativeIds.has(message.localMessageId) ? message.localMessageId : `channel:${message.id}`]));
  const messages = history.messages.flatMap<UIMessage>(message => {
    if (message.localMessageId && nativeIds.has(message.localMessageId)) return [];
    const text = [message.text, ...message.attachments.map(file => `📎 ${file.filename}`)].filter(Boolean).join("\n");
    return [{ id: `channel:${message.id}`, role: message.actor,
      metadata: { legalworkChannelHistory: true, opencode: { created: Date.parse(message.desktop?.createdAt ?? message.createdAt), completed: true } },
      parts: [{ type: "text", text, state: "done", providerMetadata: { opencode: { partId: `channel:${message.id}:text`, textComplete: true } } }],
    }];
  });
  const reactions: UIMessage[] = history.reactions.flatMap(reaction => {
    const target = targetIds.get(reaction.messageId);
    return target ? [{ id: `channel-reaction:${reaction.messageId}`, role: "assistant", metadata: { legalworkChannelHistory: true },
      parts: [{ type: "dynamic-tool", toolName: "legalwork_assistant_react", toolCallId: `channel:${reaction.messageId}:reaction`, state: "output-available",
        input: {}, output: { ok: true, reaction: { messageId: target, emoji: reaction.emoji } } }],
    }] : [];
  });
  return [...native, ...messages].sort((a, b) => {
    const left = created(a); const right = created(b);
    return left !== null && right !== null ? left - right : 0;
  }).concat(reactions);
}
