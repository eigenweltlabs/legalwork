import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SessionInboxEntry } from "@legalwork/types/scheduled-tasks";
import { useSessionManagementStore } from "./session-management-store";

type InboxState = {
  entries: Record<string, SessionInboxEntry>;
  readAt: Record<string, number>;
  pinnedRunIds: Record<string, string>;
  openSessionId: string | null;
  trackingStartedAt: number | null;
};
export function unreadSession(state: Pick<InboxState, "entries" | "readAt" | "trackingStartedAt">, sessionId: string) {
  // Older installs have no read history. Never turn their existing transcripts
  // into notifications, including cached entries before the first refresh.
  return state.trackingStartedAt !== null &&
    (state.entries[sessionId]?.assistantAt ?? 0) > Math.max(state.trackingStartedAt, state.readAt[sessionId] ?? 0);
}

export const useSessionInboxStore = create<InboxState & {
  receive: (sessions: SessionInboxEntry[], now?: number) => string[];
  open: (sessionId: string | null) => void;
}>()(persist((set, get) => ({
  entries: {}, readAt: {}, pinnedRunIds: {}, openSessionId: null, trackingStartedAt: null,
  receive: (sessions, now = Date.now()) => {
    const state = get();
    // Persist one cutoff, even for an empty initial snapshot. Replies arriving
    // after this first successful sync remain unread across app restarts;
    // historical chats loaded later stay read. Also migrates the first release.
    const trackingStartedAt = state.trackingStartedAt ?? now;
    const entries = { ...state.entries }, readAt = { ...state.readAt }, pinnedRunIds = { ...state.pinnedRunIds };
    const changed = new Set<string>();
    for (const incoming of [...sessions].sort((a, b) => (a.automation?.at ?? 0) - (b.automation?.at ?? 0))) {
      const old = entries[incoming.sessionId];
      const entry = { ...incoming, assistantAt: Math.max(incoming.assistantAt, old?.assistantAt ?? 0) };
      if (JSON.stringify(old) !== JSON.stringify(entry)) changed.add(entry.workspaceId);
      entries[entry.sessionId] = entry;
      if (state.openSessionId === entry.sessionId) readAt[entry.sessionId] = entry.assistantAt;
      const pinRunId = entry.automation?.pinRunId;
      if (pinRunId && pinnedRunIds[entry.sessionId] !== pinRunId) {
        useSessionManagementStore.getState().pinSession(entry.sessionId);
        pinnedRunIds[entry.sessionId] = pinRunId;
      }
    }
    if (state.trackingStartedAt === null || changed.size || JSON.stringify(readAt) !== JSON.stringify(state.readAt) || JSON.stringify(pinnedRunIds) !== JSON.stringify(state.pinnedRunIds)) set({ entries, readAt, pinnedRunIds, trackingStartedAt });
    return [...changed];
  },
  open: sessionId => set(state => ({ openSessionId: sessionId, ...(sessionId ? { readAt: { ...state.readAt, [sessionId]: state.entries[sessionId]?.assistantAt ?? 0 } } : {}) })),
}), {
  name: "legalwork.react.sessionInbox", storage: createJSONStorage(() => localStorage),
  partialize: ({ entries, readAt, pinnedRunIds, trackingStartedAt }) => ({ entries, readAt, pinnedRunIds, trackingStartedAt }),
}));
