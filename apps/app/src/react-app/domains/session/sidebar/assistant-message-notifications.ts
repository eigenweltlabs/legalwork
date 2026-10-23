import type { LegalworkSessionMessage } from "@/app/lib/legalwork-server";

const PREFIX = "assistant-message:";

export function assistantNotificationId(workspaceId: string, sessionId: string, messageId: string) {
  return `${PREFIX}${encodeURIComponent(workspaceId)}:${encodeURIComponent(sessionId)}:${encodeURIComponent(messageId)}`;
}

export function assistantNotificationTarget(id: string) {
  if (!id.startsWith(PREFIX)) return null;
  const parts = id.slice(PREFIX.length).split(":");
  if (parts.length !== 3 || parts.some(part => !part)) return null;
  try { return { workspaceId: decodeURIComponent(parts[0]), sessionId: decodeURIComponent(parts[1]) }; }
  catch { return null; }
}

/** Consume foreground/muted replies too, so turning alerts on never replays them. */
export class AssistantMessageNotifications {
  private seen = new Set<string>();
  constructor(readonly startedAt = Date.now()) {}

  receive(messages: LegalworkSessionMessage[], enabled: boolean, foreground: boolean) {
    const fresh = messages.flatMap(({ info, parts }) => {
      if (info.role !== "assistant" || info.summary || info.error || !info.time.completed || info.time.completed <= this.startedAt || this.seen.has(info.id)) return [];
      if (info.finish && !["stop", "length", "content-filter"].includes(info.finish)) return [];
      const text = parts.flatMap(part => part.type === "text" && !part.synthetic && !part.ignored ? [part.text.trim()] : []).filter(Boolean).join("\n");
      if (!text) return [];
      this.seen.add(info.id);
      return [{ messageId: info.id, completedAt: info.time.completed, body: text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`#]/g, "").replace(/\s+/g, " ").slice(0, 240) }];
    });
    if (!enabled || foreground) return null;
    // A reconnect can deliver several steps together. Show one alert for the latest reply.
    return fresh.sort((a, b) => a.completedAt - b.completedAt).at(-1) ?? null;
  }
}
