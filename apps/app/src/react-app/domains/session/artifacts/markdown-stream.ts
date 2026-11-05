import { create } from "zustand";

export type MarkdownStream = {
  id: string; workspaceId: string; sessionId: string; path: string; content: string;
  status: "writing" | "complete" | "failed";
};
export const useMarkdownStreams = create<{ items: Record<string, MarkdownStream> }>(() => ({ items: {} }));

export function markdownStreamPath(value: unknown) {
  if (typeof value !== "string" || !/\.(md|markdown)$/i.test(value) || /[\\\x00-\x1f\x7f]/.test(value)) return null;
  return value.split("/").every(part => part && part !== "." && part !== "..") ? value : null;
}

/** Publish actual document chunks as they arrive. Only the final chunk saves a file. */
export async function writeMarkdownChunk(input: {
  workspaceId: string; sessionId: string; path: string; content: string; append: boolean; complete: boolean;
  exists: () => Promise<boolean>; save: (content: string) => Promise<unknown>;
}) {
  if (!markdownStreamPath(input.path)) throw new Error("Use a new workspace-relative Markdown filename.");
  const id = JSON.stringify([input.workspaceId, input.sessionId, input.path]);
  const previous = useMarkdownStreams.getState().items[id];
  if (input.append && previous?.status !== "writing") throw new Error("No active draft exists. Start with append=false.");
  if (!input.append) {
    if (Object.values(useMarkdownStreams.getState().items).some(item => item.workspaceId === input.workspaceId && item.path === input.path && item.status === "writing")) {
      throw new Error("This document already has an active draft. Continue it with append=true.");
    }
    if (await input.exists()) throw new Error("That file already exists. Choose a new filename or use its editing tools.");
  }
  const content = (input.append && previous ? previous.content : "") + input.content;
  if (content.length > 4 * 1024 * 1024) throw new Error("The Markdown draft exceeds the 4 MiB limit.");
  const item: MarkdownStream = { id, workspaceId: input.workspaceId, sessionId: input.sessionId, path: input.path, content, status: "writing" };
  useMarkdownStreams.setState(state => ({ items: { ...Object.fromEntries(Object.entries(state.items).filter(([, value], index, entries) => value.status === "writing" || index >= entries.length - 49)), [id]: item } }));
  if (!input.complete) return { ok: true, path: input.path, saved: false, characters: content.length, next: "Continue with append=true. Set complete=true on the last chunk to save the file." };
  try {
    await input.save(content);
    useMarkdownStreams.setState(state => ({ items: { ...state.items, [id]: { ...item, status: "complete" } } }));
    return { ok: true, path: input.path, saved: true, characters: content.length };
  } catch (error) {
    useMarkdownStreams.setState(state => ({ items: { ...state.items, [id]: { ...item, status: "failed" } } }));
    throw error;
  }
}

/** Interrupted previews remain inspectable but can never masquerade as saved files. */
export function applyMarkdownStreamEvent(workspaceId: string, event: { type: string; data?: unknown }) {
  if (!["session.idle", "session.execution.failed", "session.execution.interrupted", "session.deleted"].includes(event.type)) return;
  const p = event.data;
  if (!p || typeof p !== "object" || !("sessionID" in p)) return;
  useMarkdownStreams.setState(state => ({ items: Object.fromEntries(Object.entries(state.items).map(([id, item]) => [id,
    item.workspaceId === workspaceId && item.sessionId === p.sessionID && item.status === "writing" ? { ...item, status: "failed" } : item,
  ])) }));
}
