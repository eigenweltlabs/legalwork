import { AssistantProfileSchema, AssistantSharedFilesSchema } from "@legalwork/types/main-assistant";
import type { TextPart } from "@/app/lib/opencode-view";
import type { UIMessage } from "ai";
import { integrationMessageMetadata } from "../surface/composer/integration-message";

export function textPartProviderMetadata(part: TextPart) {
  const sender = AssistantProfileSchema.safeParse(part.metadata?.legalworkAssistantSender);
  const files = AssistantSharedFilesSchema.safeParse(part.metadata?.legalworkSharedFiles);
  const references = integrationMessageMetadata(part.metadata?.legalworkPrompt);
  return { opencode: { partId: part.id, ...(references.integrations.length ? references : {}), ...(part.time ? { textComplete: Boolean(part.time.end) } : {}), ...(sender.success ? { legalworkAssistantSender: sender.data } : {}), ...(files.success ? { legalworkSharedFiles: files.data } : {}) } };
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
