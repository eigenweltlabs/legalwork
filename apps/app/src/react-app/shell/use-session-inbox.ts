import { useEffect, useRef } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { RouteWorkspace } from "./route-workspaces";
import { workspaceServerId } from "@/app/lib/workspace-endpoint";
import { startRequestPolling } from "@/app/lib/request-poller";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import { useSessionInboxStore } from "../domains/session/sidebar/session-inbox-store";
import type { SessionInboxEntry } from "@legalwork/types/scheduled-tasks";
import { useSessionActivityStore } from "../domains/session/status/session-activity-store";

export function reconcileInboxActivity(sessions: SessionInboxEntry[]) {
  const activity = useSessionActivityStore.getState();
  for (const entry of sessions) {
    if (entry.status && entry.status !== "unknown") activity.setRunStatus(entry.workspaceId, entry.sessionId, entry.status);
  }
}

type ListedSession = { id: string; time?: { updated?: number; created?: number } };

export function inboxNeedsRefresh(entries: SessionInboxEntry[], listed: ListedSession[]) {
  const ids = new Set(listed.map(session => session.id));
  // Older chats outside the sidebar's page do not cause perpetual reloads.
  const oldest = listed.length >= 200 ? Math.min(...listed.map(session => session.time?.updated ?? session.time?.created ?? 0)) : 0;
  return entries.some(entry => !ids.has(entry.sessionId) && entry.updatedAt >= oldest);
}

/** Metadata reconciliation covers background chats, reconnects and replies received while closed. */
export function useSessionInbox(client: LegalworkServerClient | null, workspaces: RouteWorkspace[], listed: Record<string, ListedSession[]>, reload: (workspaces: RouteWorkspace[]) => Promise<unknown>) {
  const latest = useRef({ client, workspaces, listed, reload });
  latest.current = { client, workspaces, listed, reload };
  const workspaceKey = workspaces.map(workspace => workspace.id).join("|");
  useEffect(() => {
    if (!client) return;
    let lastFullRefresh = 0;
    let previous: SessionInboxEntry[] = [];
    const poller = startRequestPolling(async signal => {
      const { sessions } = await latest.current.client!.sessionInbox(signal);
      if (signal.aborted) return;
      reconcileInboxActivity(sessions);
      const changed = new Set(useSessionInboxStore.getState().receive(sessions));
      const ids = new Set(sessions.map(entry => entry.sessionId));
      // Archive/deletion is a change too, so unchanged projects no longer need
      // full list downloads every thirty seconds to discover removed chats.
      for (const entry of previous) if (!ids.has(entry.sessionId)) changed.add(entry.workspaceId);
      previous = sessions;
      const fullRefresh = Date.now() - lastFullRefresh >= 5 * 60_000;
      const targets = latest.current.workspaces.filter(workspace => (
        fullRefresh || changed.has(workspaceServerId(workspace)) ||
        inboxNeedsRefresh(sessions.filter(entry => entry.workspaceId === workspaceServerId(workspace)), latest.current.listed[workspace.id] ?? [])
      ));
      if (fullRefresh) lastFullRefresh = Date.now();
      if (targets.length) await latest.current.reload(targets);
    }, { intervalMs: 5000, pauseWhenHidden: false });
    const unsubscribe = onSyncPoke(poke => { if (poke.sessions || poke.resync) poller.wake(); });
    const wake = () => poller.wake();
    window.addEventListener("focus", wake);
    return () => { poller.stop(); unsubscribe(); window.removeEventListener("focus", wake); };
  }, [client?.baseUrl, workspaceKey]);
  useEffect(() => {
    const syncRead = (event: StorageEvent) => { if (event.key === "legalwork.react.sessionInbox") void useSessionInboxStore.persist.rehydrate(); };
    window.addEventListener("storage", syncRead);
    return () => window.removeEventListener("storage", syncRead);
  }, []);
}
