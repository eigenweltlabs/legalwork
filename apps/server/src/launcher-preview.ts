import type { LauncherPreview, LauncherSearchKind } from "@legalwork/types/launcher";

export const PREVIEW_CHARS = 6000;

/** Clamp preview text; the flag says the reader sees only the beginning. */
export function clampPreview(text: string, limit = PREVIEW_CHARS): { text: string; truncated: boolean } {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  return trimmed.length > limit ? { text: `${trimmed.slice(0, limit).trimEnd()}…`, truncated: true } : { text: trimmed, truncated: false };
}

export type PreviewMessage = { role: string; text: string; time: number | null };
/** Chat previews show the last exchanges, newest last, with the role in front of each turn. */
export function messagesPreview(messages: PreviewMessage[], limit = PREVIEW_CHARS): { text: string; truncated: boolean } {
  const turns = messages.filter(message => message.text.trim()).map(message => `${message.role === "user" ? "You" : "Assistant"}: ${message.text.trim()}`);
  let text = "", truncated = false;
  for (const turn of turns.reverse()) {
    const next = text ? `${turn}\n\n${text}` : turn;
    if (next.length > limit) { truncated = true; if (!text) text = clampPreview(turn, limit).text; break; }
    text = next;
  }
  return { text, truncated };
}

export type PreviewSource = { kind: LauncherSearchKind; id: string; title: string; meta: string[]; updatedAt: number | null };
export function assemblePreview(source: PreviewSource, body: { text: string; truncated: boolean }, origin: LauncherPreview["source"]): LauncherPreview {
  return { kind: source.kind, id: source.id, title: source.title, meta: source.meta, text: body.text, truncated: body.truncated, source: origin, updatedAt: source.updatedAt };
}
