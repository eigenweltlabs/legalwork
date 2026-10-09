import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SessionInboxEntry } from "@legalwork/types/scheduled-tasks";
import { useSessionManagementStore } from "./session-management-store";

type InboxState = {
  entries: Record<string, SessionInboxEntry>;
  readAt: Record<string, number>;
  pinnedRunIds: Record<string, string>;
  openSessionId: string | null;
  openWorkspaceId: string | null;
  trackingStartedAt: number | null;
};
function activityAt(entry?: SessionInboxEntry) {
  // New servers supply terminal reply timestamps. A scheduled delivery is a
  // user turn, not a reply. Keep compatibility with older servers only.
  return entry?.status === undefined ? Math.max(entry?.assistantAt ?? 0, entry?.automation?.at ?? 0) : entry.assistantAt;
}
export function unreadSession(state: Pick<InboxState, "entries" | "readAt" | "trackingStartedAt">, sessionId: string) {
  // Older installs have no read history. Never turn their existing transcripts
  // into notifications, including cached entries before the first refresh.
  return state.trackingStartedAt !== null &&
    (state.entries[sessionId]?.status === undefined || state.entries[sessionId]?.status === "idle") &&
    activityAt(state.entries[sessionId]) > Math.max(state.trackingStartedAt, state.readAt[sessionId] ?? 0);
}
export function unreadWorkspace(state: Pick<InboxState, "entries" | "readAt" | "trackingStartedAt">, workspaceId?: string) {
  return Boolean(workspaceId) && Object.values(state.entries).some(entry => entry.workspaceId === workspaceId && unreadSession(state, entry.sessionId));
}
export function runningWorkspace(state: Pick<InboxState, "entries">, workspaceId: string) {
  return Object.values(state.entries).some(entry => entry.workspaceId === workspaceId && (entry.status === "busy" || entry.status === "retry"));
}

export const useSessionInboxStore = create<InboxState & {
  receive: (sessions: SessionInboxEntry[], now?: number) => string[];
  open: (sessionId: string | null, workspaceId?: string | null) => void;
}>()(persist((set, get) => ({
  entries: {}, readAt: {}, pinnedRunIds: {}, openSessionId: null, openWorkspaceId: null, trackingStartedAt: null,
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
      const entry = { ...incoming, assistantAt: incoming.status === undefined ? Math.max(incoming.assistantAt, old?.assistantAt ?? 0) : incoming.assistantAt };
      if (JSON.stringify(old) !== JSON.stringify(entry)) changed.add(entry.workspaceId);
      entries[entry.sessionId] = entry;
      if ((entry.status === undefined || entry.status === "idle") && (state.openSessionId === entry.sessionId || state.openWorkspaceId === entry.workspaceId)) readAt[entry.sessionId] = activityAt(entry);
      const pinRunId = entry.automation?.pinRunId;
      if (pinRunId && pinnedRunIds[entry.sessionId] !== pinRunId) {
        useSessionManagementStore.getState().pinSession(entry.sessionId);
        pinnedRunIds[entry.sessionId] = pinRunId;
      }
    }
    if (state.trackingStartedAt === null || changed.size || JSON.stringify(readAt) !== JSON.stringify(state.readAt) || JSON.stringify(pinnedRunIds) !== JSON.stringify(state.pinnedRunIds)) set({ entries, readAt, pinnedRunIds, trackingStartedAt });
    return [...changed];
  },
  open: (sessionId, workspaceId = null) => set(state => {
    const readAt = { ...state.readAt };
    if (sessionId) {
      const entry = state.entries[sessionId];
      if (!entry?.status || entry.status === "idle") readAt[sessionId] = activityAt(entry);
      if (workspaceId) for (const entry of Object.values(state.entries)) {
        if (entry.workspaceId === workspaceId && (!entry.status || entry.status === "idle")) readAt[entry.sessionId] = activityAt(entry);
      }
    }
    return { openSessionId: sessionId, openWorkspaceId: sessionId ? workspaceId : null, readAt };
  }),
}), {
  name: "legalwork.react.sessionInbox", storage: createJSONStorage(() => localStorage),
  partialize: ({ entries, readAt, pinnedRunIds, trackingStartedAt }) => ({ entries, readAt, pinnedRunIds, trackingStartedAt }),
}));
