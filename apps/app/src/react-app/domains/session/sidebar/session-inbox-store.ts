import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SessionInboxEntry } from "@legalwork/types/scheduled-tasks";
import { useSessionManagementStore } from "./session-management-store";

type InboxState = {
  entries: Record<string, SessionInboxEntry>;
  readAt: Record<string, number>;
  pinnedRunIds: Record<string, string>;
  openSessionId: string | null;
};
export function unreadSession(state: Pick<InboxState, "entries" | "readAt">, sessionId: string) {
  return (state.entries[sessionId]?.assistantAt ?? 0) > (state.readAt[sessionId] ?? 0);
}

export const useSessionInboxStore = create<InboxState & {
  receive: (sessions: SessionInboxEntry[]) => string[];
  open: (sessionId: string | null) => void;
}>()(persist((set, get) => ({
  entries: {}, readAt: {}, pinnedRunIds: {}, openSessionId: null,
  receive: sessions => {
    const state = get();
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
    if (changed.size || JSON.stringify(readAt) !== JSON.stringify(state.readAt) || JSON.stringify(pinnedRunIds) !== JSON.stringify(state.pinnedRunIds)) set({ entries, readAt, pinnedRunIds });
    return [...changed];
  },
  open: sessionId => set(state => ({ openSessionId: sessionId, ...(sessionId ? { readAt: { ...state.readAt, [sessionId]: state.entries[sessionId]?.assistantAt ?? 0 } } : {}) })),
}), {
  name: "legalwork.react.sessionInbox", storage: createJSONStorage(() => localStorage),
  partialize: ({ entries, readAt, pinnedRunIds }) => ({ entries, readAt, pinnedRunIds }),
}));
