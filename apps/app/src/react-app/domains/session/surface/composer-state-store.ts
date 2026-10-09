import { retainSessionInLists } from "../sidebar/session-list-visibility";
import { create } from "zustand";

import type { ComposerAttachment, ComposerDraft } from "../../../../app/types";
import type { ComposerMentionKind } from "./composer/mention-encoding";

export type ComposerPastePart = {
  id: string;
  label: string;
  text: string;
  lines: number;
};

export type ComposerSessionState = {
  /** The queue slot reserved while this draft is being edited. */
  queuedDraftId?: string;
  draft: string;
  attachments: ComposerAttachment[];
  mentions: Record<string, ComposerMentionKind>;
  pasteParts: ComposerPastePart[];
};

export type QueuedComposerDraft = ComposerDraft & {
  id: string;
  status?: "queued" | "sending" | "failed" | "uncertain";
  error?: string;
  locked?: boolean;
  editor: ComposerSessionState;
};

export type ComposerStateStore = {
  sessions: Record<string, ComposerSessionState>;
  queuedDrafts: Record<string, QueuedComposerDraft[]>;
  pausedQueues: Record<string, boolean>;
  stashedDrafts: Record<string, ComposerSessionState[]>;
  /**
   * Sent-prompt history per session, oldest first. Kept outside
   * `sessions` because `clearSession` resets the composer after every
   * send and must not wipe the recall history (#2012).
   */
  history: Record<string, string[]>;
  setDraft: (sessionId: string, draft: string) => void;
  setAttachments: (sessionId: string, attachments: ComposerAttachment[]) => void;
  setMentions: (sessionId: string, mentions: Record<string, ComposerMentionKind>) => void;
  setPasteParts: (sessionId: string, pasteParts: ComposerPastePart[]) => void;
  appendHistory: (sessionId: string, text: string) => void;
  appendQueuedDraft: (sessionId: string, draft: ComposerDraft, editor?: ComposerSessionState) => void;
  editQueuedDraft: (sessionId: string, id: string) => void;
  recoverQueuedEdit: (sessionId: string) => boolean;
  reorderQueuedDrafts: (sessionId: string, ids: string[]) => void;
  setQueuePaused: (sessionId: string, paused: boolean) => void;
  removeQueuedDraft: (sessionId: string, id: string) => void;
  clearQueuedDrafts: (sessionId: string) => void;
  prependQueuedDrafts: (sessionId: string, drafts: QueuedComposerDraft[]) => void;
  clearSession: (sessionId: string) => void;
};

const EMPTY_ATTACHMENTS: ComposerAttachment[] = [];
const EMPTY_MENTIONS: Record<string, ComposerMentionKind> = {};
const EMPTY_PASTE_PARTS: ComposerPastePart[] = [];
const EMPTY_HISTORY: string[] = [];
const EMPTY_QUEUED_DRAFTS: QueuedComposerDraft[] = [];
const HISTORY_LIMIT = 50;

function createEmptyComposerSession(): ComposerSessionState {
  return {
    draft: "",
    attachments: [],
    mentions: {},
    pasteParts: [],
  };
}

function getWritableSession(state: ComposerStateStore, sessionId: string): ComposerSessionState {
  return state.sessions[sessionId] ?? createEmptyComposerSession();
}

function queuedDraft(state: ComposerStateStore, sessionId: string, draft: ComposerDraft, editor = getWritableSession(state, sessionId)): QueuedComposerDraft {
  return { ...draft, id: crypto.randomUUID(), editor: { ...editor, draft: draft.text, attachments: draft.attachments } };
}

function restoreComposer(state: ComposerStateStore, sessionId: string) {
  const sessions = { ...state.sessions };
  const stash = state.stashedDrafts[sessionId] ?? [];
  const previous = stash[stash.length - 1];
  if (previous) sessions[sessionId] = previous;
  else delete sessions[sessionId];
  return { sessions, stashedDrafts: { ...state.stashedDrafts, [sessionId]: stash.slice(0, -1) } };
}

export const useComposerStateStore = create<ComposerStateStore>((set) => ({
  sessions: {},
  queuedDrafts: {},
  pausedQueues: {},
  stashedDrafts: {},
  history: {},
  setDraft: (sessionId, draft) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.draft === draft) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, draft } } };
  }),
  setAttachments: (sessionId, attachments) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.attachments === attachments) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, attachments } } };
  }),
  setMentions: (sessionId, mentions) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.mentions === mentions) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, mentions } } };
  }),
  setPasteParts: (sessionId, pasteParts) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.pasteParts === pasteParts) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, pasteParts } } };
  }),
  appendHistory: (sessionId, text) => set((state) => {
    const trimmed = text.trim();
    if (!trimmed) return state;
    const current = state.history[sessionId] ?? EMPTY_HISTORY;
    // Skip consecutive duplicates so spamming the same prompt does not
    // fill the recall buffer.
    if (current[current.length - 1] === trimmed) return state;
    const next = [...current, trimmed].slice(-HISTORY_LIMIT);
    return { history: { ...state.history, [sessionId]: next } };
  }),
  appendQueuedDraft: (sessionId, draft, editor) => set((state) => {
    const current = state.queuedDrafts[sessionId] ?? EMPTY_QUEUED_DRAFTS;
    const editingId = editor ? undefined : state.sessions[sessionId]?.queuedDraftId;
    const item = queuedDraft(state, sessionId, draft, editor);
    delete item.editor.queuedDraftId;
    const next = current.some((entry) => entry.id === editingId)
      ? current.map((entry) => entry.id === editingId ? { ...item, id: entry.id } : entry)
      : [...current, item];
    return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: next } };
  }),
  editQueuedDraft: (sessionId, id) => set((state) => {
    const current = state.queuedDrafts[sessionId] ?? EMPTY_QUEUED_DRAFTS;
    const item = current.find((entry) => entry.id === id);
    if (!item) return state;
    const editor = getWritableSession(state, sessionId);
    if (editor.queuedDraftId) return state;
    // Editing must never submit another draft the user has not sent.
    const stash = state.stashedDrafts[sessionId] ?? [];
    return {
      sessions: { ...state.sessions, [sessionId]: { ...item.editor, queuedDraftId: id } },
      stashedDrafts: { ...state.stashedDrafts, [sessionId]: editor.draft.trim() || editor.attachments.length ? [...stash, editor] : stash },
    };
  }),
  recoverQueuedEdit: (sessionId) => {
    let recovered = false;
    set(state => {
      const editor = state.sessions[sessionId];
      if (!editor?.queuedDraftId) return state;
      recovered = true;
      return { sessions: { ...state.sessions, [sessionId]: { ...editor, queuedDraftId: undefined } } };
    });
    return recovered;
  },
  reorderQueuedDrafts: (sessionId, ids) => set((state) => {
    const current = state.queuedDrafts[sessionId];
    if (!current) return state;
    const remaining = new Map(current.map((item) => [item.id, item]));
    const next: QueuedComposerDraft[] = [];
    for (const id of ids) {
      const item = remaining.get(id);
      if (!item) continue;
      next.push(item);
      remaining.delete(id);
    }
    // A drag event may race with a removal or a newly queued message.
    next.push(...remaining.values());
    if (next.every((item, index) => item === current[index])) return state;
    return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: next } };
  }),
  setQueuePaused: (sessionId, paused) => set((state) => ({ pausedQueues: { ...state.pausedQueues, [sessionId]: paused } })),
  removeQueuedDraft: (sessionId, id) => set((state) => {
    const current = state.queuedDrafts[sessionId];
    if (!current) return state;
    const next = current.filter((item) => item.id !== id);
    if (next.length === current.length) return state;
    const queuedDrafts = { ...state.queuedDrafts };
    if (next.length) queuedDrafts[sessionId] = next;
    else delete queuedDrafts[sessionId];
    return { queuedDrafts, ...(state.sessions[sessionId]?.queuedDraftId === id ? restoreComposer(state, sessionId) : {}) };
  }),
  clearQueuedDrafts: (sessionId) => set((state) => {
    if (!state.queuedDrafts[sessionId]) return state;
    const queuedDrafts = { ...state.queuedDrafts };
    delete queuedDrafts[sessionId];
    return { queuedDrafts, ...(state.sessions[sessionId]?.queuedDraftId ? restoreComposer(state, sessionId) : {}) };
  }),
  prependQueuedDrafts: (sessionId, drafts) => set((state) => {
    if (drafts.length === 0) return state;
    const current = state.queuedDrafts[sessionId] ?? EMPTY_QUEUED_DRAFTS;
    return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: [...drafts, ...current] } };
  }),
  clearSession: (sessionId) => set((state) => {
    if (!state.sessions[sessionId]) return state;
    return restoreComposer(state, sessionId);
  }),
}));

export function getComposerDraft(state: ComposerStateStore, sessionId: string): string {
  return state.sessions[sessionId]?.draft ?? "";
}

export function getComposerAttachments(state: ComposerStateStore, sessionId: string): ComposerAttachment[] {
  return state.sessions[sessionId]?.attachments ?? EMPTY_ATTACHMENTS;
}

export function getComposerMentions(state: ComposerStateStore, sessionId: string): Record<string, ComposerMentionKind> {
  return state.sessions[sessionId]?.mentions ?? EMPTY_MENTIONS;
}

export function getComposerPasteParts(state: ComposerStateStore, sessionId: string): ComposerPastePart[] {
  return state.sessions[sessionId]?.pasteParts ?? EMPTY_PASTE_PARTS;
}

export function getComposerHistory(state: ComposerStateStore, sessionId: string): string[] {
  return state.history[sessionId] ?? EMPTY_HISTORY;
}

export function getComposerQueuedDrafts(state: ComposerStateStore, sessionId: string): QueuedComposerDraft[] {
  return state.queuedDrafts[sessionId] ?? EMPTY_QUEUED_DRAFTS;
}

export function isComposerQueuePaused(state: ComposerStateStore, sessionId: string): boolean {
  const editingId = state.sessions[sessionId]?.queuedDraftId;
  return Boolean(state.pausedQueues[sessionId]
    || (editingId && editingId === state.queuedDrafts[sessionId]?.[0]?.id));
}

// Share only the fact that a chat has been used, never another window's input.
useComposerStateStore.subscribe((state, previous) => {
  for (const [id, composer] of Object.entries(state.sessions)) {
    if (composer !== previous.sessions[id] && (composer.draft.trim() || composer.attachments.length || composer.pasteParts.length)) retainSessionInLists(id);
  }
  for (const [id, queue] of Object.entries(state.queuedDrafts)) {
    if (queue !== previous.queuedDrafts[id] && queue.length) retainSessionInLists(id);
  }
  for (const [id, history] of Object.entries(state.history)) {
    if (history !== previous.history[id] && history.length) retainSessionInLists(id);
  }
});
