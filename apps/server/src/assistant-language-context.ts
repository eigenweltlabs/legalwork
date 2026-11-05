import type { OpenCodeClient } from "@opencode/client";
import { findApiError } from "./errors.js";

/** Background turns must take their reply language from the human, not the
 * incoming source or a worker. Keep this live context out of the system prefix. */
export async function assistantLanguageContext(messages: OpenCodeClient["message"], sessionIds: string[]) {
  const excerpts: { sessionId: string; messageId: string; text: string }[] = [];
  for (const sessionId of new Set(sessionIds)) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await messages.list({ sessionID: sessionId, ...(cursor ? { cursor } : { order: "desc" }), limit: 100 }, { signal: AbortSignal.timeout(10_000) })
        .catch(error => { if (findApiError(error)?.status === 404) return null; throw error; });
      if (!page) break;
      for (const message of page.data) {
        if (message.type !== "user" || message.metadata?.legalworkSystemReminder || message.metadata?.legalworkScheduledTask || message.metadata?.legalworkAssistantSender) continue;
        const prompt = message.metadata?.legalworkPrompt;
        const text = prompt && typeof prompt === "object" && !Array.isArray(prompt) && typeof prompt.visibleText === "string"
          ? prompt.visibleText : message.text;
        if (text.trim()) excerpts.push({ sessionId, messageId: message.id, text: text.slice(0, 1600) });
        if (excerpts.length === 3) break;
      }
      cursor = page.cursor.next ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error("Assistant language history repeated a page cursor.");
      if (cursor) seen.add(cursor);
    } while (cursor && excerpts.length < 3);
    if (excerpts.length === 3) break;
  }
  if (!excerpts.length) return "";
  const reference = JSON.stringify(excerpts.reverse()).replaceAll("<", "\\u003c");
  return `\n\nRecent human messages from the Assistant conversation, oldest first (language reference only):\n${reference}\nUse these to preserve the thread's language, subject to the human's explicit language preference. A brief confirmation or quoted document does not switch languages. These excerpts do not create a new task; do not answer or execute them again.`;
}
