import { useEffect, useRef } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { RouteWorkspace } from "./route-workspaces";
import { workspaceServerId } from "@/app/lib/workspace-endpoint";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import { useSessionInboxStore } from "../domains/session/sidebar/session-inbox-store";
import type { SessionInboxEntry } from "@legalwork/types/scheduled-tasks";

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
    let stopped = false, running = false, pending = false;
    let timer: ReturnType<typeof setTimeout>;
    let lastFullRefresh = 0;
    const poll = async () => {
      clearTimeout(timer);
      if (running) { pending = true; return; }
      running = true;
      try {
        const { sessions } = await latest.current.client!.sessionInbox();
        if (stopped) return;
        const changed = new Set(useSessionInboxStore.getState().receive(sessions));
        const fullRefresh = Date.now() - lastFullRefresh >= 30_000;
        const targets = latest.current.workspaces.filter(workspace => workspace.workspaceType !== "remote" && (
          fullRefresh || changed.has(workspaceServerId(workspace)) ||
          inboxNeedsRefresh(sessions.filter(entry => entry.workspaceId === workspaceServerId(workspace)), latest.current.listed[workspace.id] ?? [])
        ));
        if (fullRefresh) lastFullRefresh = Date.now();
        if (targets.length) await latest.current.reload(targets);
      } catch { /* Server starting or reconnecting. Retain the last known state and retry. */ }
      finally {
        running = false;
        if (!stopped) { timer = setTimeout(() => void poll(), pending ? 0 : 5000); pending = false; }
      }
    };
    const unsubscribe = onSyncPoke(poke => { if (poke.sessions || poke.resync) void poll(); });
    const wake = () => { void poll(); };
    window.addEventListener("focus", wake);
    void poll();
    return () => { stopped = true; clearTimeout(timer); unsubscribe(); window.removeEventListener("focus", wake); };
  }, [client?.baseUrl, workspaceKey]);
  useEffect(() => {
    const syncRead = (event: StorageEvent) => { if (event.key === "legalwork.react.sessionInbox") void useSessionInboxStore.persist.rehydrate(); };
    window.addEventListener("storage", syncRead);
    return () => window.removeEventListener("storage", syncRead);
  }, []);
}
