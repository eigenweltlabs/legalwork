import { AssistantProfileSchema, AssistantSharedFilesSchema } from "@legalwork/types/main-assistant";
import type { TextPart } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";

export function textPartProviderMetadata(part: TextPart) {
  const sender = AssistantProfileSchema.safeParse(part.metadata?.legalworkAssistantSender);
  const files = AssistantSharedFilesSchema.safeParse(part.metadata?.legalworkSharedFiles);
  return { opencode: { partId: part.id, ...(part.time?.end ? { textComplete: true } : {}), ...(sender.success ? { legalworkAssistantSender: sender.data } : {}), ...(files.success ? { legalworkSharedFiles: files.data } : {}) } };
}

export function assistantMessageSender(message: UIMessage) {
  if (message.role !== "user") return null;
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    const sender = AssistantProfileSchema.safeParse(part.providerMetadata?.opencode?.legalworkAssistantSender);
    if (sender.success) return sender.data;
  }
  return null;
}
