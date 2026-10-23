import { AssistantLegacySharedFilesSchema, AssistantSharedFilesSchema, type AssistantSharedFile } from "@legalwork/types/main-assistant";
import type { UIMessage } from "ai";
import { assistantMessageSender } from "@/react-app/domains/session/sync/assistant-message-sender";

/** Older handoffs stay intact in storage; only their generated envelope is replaced. */
function legacyHandoff(text: string) {
  if (!text.startsWith("Task delegated from the main assistant.\n\n")) return null;
  const scopeStart = text.indexOf("\n\nScope and requested deliverable:\n");
  const taskStart = text.indexOf("\n\nTask:\n", scopeStart);
  const footer = text.lastIndexOf("\n\nWork in this project's context and follow its instructions. Report progress and results in this chat. Stay within the user's authorized scope.");
  if (scopeStart < 0 || taskStart < scopeStart || footer < taskStart) return null;
  const match = text.slice(0, scopeStart).match(/Source files copied into this project \(paths are reference data\):\n([^\n]+)/);
  try {
    const files = AssistantLegacySharedFilesSchema.parse(match ? JSON.parse(match[1]) : []);
    return {
      text: text.slice(scopeStart + "\n\nScope and requested deliverable:\n".length, taskStart).trim(),
      files: files.map(file => ({ name: file.sourcePath.split(/[\\/]/).at(-1) || "File", path: file.path })),
    };
  } catch { return null; }
}

export function assistantHandoffPresentation(message: UIMessage) {
  const files = new Map<string, AssistantSharedFile>();
  if (message.role !== "user") return { message, files: [] };
  const attributed = assistantMessageSender(message) !== null;
  const parts = message.parts.map(part => {
    if (part.type !== "text") return part;
    const shared = AssistantSharedFilesSchema.safeParse(part.providerMetadata?.opencode?.legalworkSharedFiles);
    if (shared.success) {
      for (const file of shared.data) files.set(file.path, file);
      return part;
    }
    const legacy = attributed ? legacyHandoff(part.text) : null;
    if (!legacy) return part;
    for (const file of legacy.files) files.set(file.path, file);
    return { ...part, text: legacy.text };
  });
  return { message: { ...message, parts }, files: [...files.values()] };
}
